// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { engineInstance } from '../src/security-authority/decision-engine.mjs';
import { SecurityState } from '../src/security-authority/state-machine/states.mjs';
import { StorageAdapter } from '../src/security-authority/persistence/storage-adapter.mjs';
import { COMMAND_CAPABILITY_MAP } from '../src/command/commandRouter.mjs';
import { CAPABILITY } from '../src/security-authority/authorization/capabilities.mjs';
import { VaultCredentialPipeline } from '../src/runtime-manager/boundary/VaultCredentialPipeline.mjs';
import { BackendSyncService } from '../src/sync/backendSyncService.mjs';
import {
  resolveExecutionScriptHash,
  computeFileSha256,
  loadExecutionIntegrityManifest
} from '../src/security-authority/execution/execution-integrity.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';
import { CanonicalSerializer } from '../src/security-authority/protocol/canonical-serializer.mjs';

test('White-Box Security & Stability Redesign Invariants (Control Plane)', async (t) => {
  await t.test('Pillar 1: establishSession verifies cryptographic license signature and rejects forged signature', async () => {
    await StorageAdapter.initDatabase(':memory:');
    await securityFacade.initialize(':memory:');

    const kp = NativeCore.generateEd25519Keypair();
    const prevPinnedKey = process.env.PINNED_BACKEND_PUBKEY_HEX;
    process.env.PINNED_BACKEND_PUBKEY_HEX = kp.publicKey;

    try {
      // 1. Forged signature on license payload must fail closed (PARTIAL / non-OPERATIONAL)
      const forgedRes = await securityFacade.establishSession({
        sessionId: 'sess-wb-forged',
        accountId: 'acc-wb-1',
        capabilities: [CAPABILITY.AUTOMATION_START, CAPABILITY.BET_PLACE],
        license: {
          license_id: 'lic-forged-1',
          account_id: 'acc-wb-1',
          plan_id: 'pro',
          status: 'VALID',
          key_version: 1,
          signature: 'deadbeef'.repeat(16)
        }
      });
      assert.strictEqual(forgedRes.status, 'AUTHENTICATED', 'Forged license signature must prevent OPERATIONAL transition');
      assert.match(String(forgedRes.message), /signature verification failed/i);
      assert.strictEqual(securityFacade.getSystemState(), SecurityState.AUTHENTICATED);
      assert.strictEqual(securityFacade.isCommandPermitted('START_AUTOMATION'), false, 'START_AUTOMATION must be denied when license signature is invalid');

      // 2. Cryptographically valid signature signed with key_version 1 must transition to OPERATIONAL
      const validClaims = {
        license_id: 'lic-valid-1',
        account_id: 'acc-wb-1',
        plan_id: 'pro',
        status: 'VALID',
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString()
      };
      const canonicalBytes = Buffer.from(CanonicalSerializer.canonicalStringify(validClaims), 'utf8');
      const validSig = NativeCore.signEd25519(kp.privateKey, canonicalBytes);

      const validRes = await securityFacade.establishSession({
        sessionId: 'sess-wb-valid',
        accountId: 'acc-wb-1',
        capabilities: [CAPABILITY.AUTOMATION_START, CAPABILITY.BET_PLACE],
        license: {
          ...validClaims,
          key_version: 1,
          signature: validSig
        }
      });
      assert.strictEqual(validRes.status, 'OPERATIONAL', 'Valid Ed25519-signed license must transition to OPERATIONAL');
      assert.strictEqual(securityFacade.getSystemState(), SecurityState.OPERATIONAL);
    } finally {
      if (prevPinnedKey === undefined) {
        delete process.env.PINNED_BACKEND_PUBKEY_HEX;
      } else {
        process.env.PINNED_BACKEND_PUBKEY_HEX = prevPinnedKey;
      }
    }
  });

  await t.test('Pillar 3: COMMAND_CAPABILITY_MAP completeness, COMPROMISED hard lockdown, and LOGOUT_INTENT from degraded states', async () => {
    assert.strictEqual(COMMAND_CAPABILITY_MAP.FREEZE_ACCOUNT, CAPABILITY.AUTOMATION_STOP);
    assert.strictEqual(COMMAND_CAPABILITY_MAP.CANCEL_ALL_BETS, CAPABILITY.AUTOMATION_STOP);
    assert.strictEqual(COMMAND_CAPABILITY_MAP.RESET_ACCOUNT_CONFIG, CAPABILITY.CONFIG_MODIFY);
    assert.strictEqual(COMMAND_CAPABILITY_MAP.SYNC_ACCOUNTS, CAPABILITY.ACCOUNT_MANAGE);
    assert.strictEqual(COMMAND_CAPABILITY_MAP.UPDATE_PASSWORD, CAPABILITY.ACCOUNT_MANAGE);

    // Transition to degraded (REAUTHENTICATION_REQUIRED) and verify LOGOUT_INTENT is permitted and persists cleared session to SQLite
    await securityFacade.transitionToDegraded('NETWORK_OFFLINE_TEST');
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.REAUTHENTICATION_REQUIRED);

    await securityFacade.logout();
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.LOGGED_OUT);

    const persistedRow = await StorageAdapter.getSecurityStateRow();
    assert.strictEqual(persistedRow.session, null, 'Persisted SQLite session must be scrubbed on logout');
    assert.strictEqual(persistedRow.license, null, 'Persisted SQLite license must be scrubbed on logout');

    // Verify COMPROMISED hard lockdown blocks non-emergency mutating commands
    engineInstance.inMemoryState.state = SecurityState.COMPROMISED;
    assert.strictEqual(securityFacade.isCommandPermitted('UPDATE_GLOBAL_CONFIG'), false, 'COMPROMISED state must block UPDATE_GLOBAL_CONFIG');
    assert.strictEqual(securityFacade.isCommandPermitted('REGISTER_ACCOUNT'), false, 'COMPROMISED state must block REGISTER_ACCOUNT');
    assert.strictEqual(securityFacade.isCommandPermitted('STOP_AUTOMATION'), true, 'STOP_AUTOMATION safety command remains permitted');
  });

  await t.test('Pillar 4: VaultCredentialPipeline encrypts credentials in memory and zeroizes safely on clear()', () => {
    const vault = new VaultCredentialPipeline();
    vault.storeCredential('acc-vault-1', 'SuperSecretBookmakerPass!2026');

    const rawEntry = vault._vault.get('acc-vault-1');
    assert.ok(rawEntry, 'Vault entry must exist');
    assert.strictEqual(/** @type {any} */ (rawEntry).plaintext, undefined, 'Plaintext password must NEVER be stored in _vault');
    assert.ok(Buffer.isBuffer(rawEntry.encryptedPassword), 'Encrypted password buffer must be stored');
    assert.ok(!rawEntry.encryptedPassword.toString('utf8').includes('SuperSecretBookmakerPass!2026'), 'Ciphertext must not contain plaintext');

    const decrypted = vault.decryptCredential('acc-vault-1');
    assert.strictEqual(decrypted, 'SuperSecretBookmakerPass!2026', 'decryptCredential must recover original password');
    assert.strictEqual(/** @type {any} */ (vault._vault.get('acc-vault-1')).plaintext, undefined, 'decryptCredential must not cache plaintext back into _vault');

    // Must not throw on clear() and must zeroize buffer
    assert.doesNotThrow(() => vault.clear());
    assert.strictEqual(vault.hasCredential('acc-vault-1'), false);
  });

  await t.test('Pillar 4: BackendSyncService encrypts sync_outbox payloads and fails fast on policy rejections', async () => {
    const capturedRuns = [];
    const mockEngine = {
      exec() {},
      query() { return []; },
      run(sql, params) {
        capturedRuns.push({ sql, params });
      }
    };

    const syncSvc = new BackendSyncService({
      enableWebSocket: false,
      engine: mockEngine,
      cachePath: path.join(os.tmpdir(), `acp_wb_test_${process.pid}.enc`)
    });

    const item = syncSvc.enqueueOutbox('REGISTER_ACCOUNT', {
      accountUsername: 'bettor99',
      accountPassword: 'PlaintextBookmakerPassword99!'
    });
    assert.ok(item.id);
    assert.strictEqual(capturedRuns.length, 1);
    const persistedPayloadStr = capturedRuns[0].params[2];
    assert.ok(persistedPayloadStr.startsWith('enc:v1:'), 'Persisted sync_outbox payload_json must be AEAD-encrypted with enc:v1: prefix');
    assert.ok(!persistedPayloadStr.includes('PlaintextBookmakerPassword99!'), 'Encrypted outbox column must not leak plaintext password');

    const decryptedPayload = syncSvc._decryptOutboxPayload(persistedPayloadStr);
    assert.strictEqual(decryptedPayload.accountPassword, 'PlaintextBookmakerPassword99!');

    // Fail-fast on policy rejection in syncMutation
    syncSvc.isConnected = true;
    syncSvc._dispatchMutation = async () => {
      const err = new Error('Seat/account limit exceeded');
      // @ts-ignore
      err.code = 'ENTITLEMENT_LIMIT_REACHED';
      // @ts-ignore
      err.status = 403;
      throw err;
    };

    const outboxBefore = syncSvc.outbox.length;
    await assert.rejects(
      async () => {
        await syncSvc.syncMutation('REGISTER_ACCOUNT', { accountUsername: 'overlimit' });
      },
      (err) => err.code === 'ENTITLEMENT_LIMIT_REACHED' && err.isPolicyRejection === true
    );
    assert.strictEqual(syncSvc.outbox.length, outboxBefore, 'Policy rejection must NOT be enqueued into retry outbox');
  });

  await t.test('Pillar 5: Pluggable Execution Plane Script Integrity manifest and override resolution', () => {
    const manifest = loadExecutionIntegrityManifest();
    assert.strictEqual(manifest.version, 1);
    assert.ok(Object.keys(manifest.targets).length > 0, 'config/execution-integrity.json must contain hashed targets');

    const mockWorkerPath = path.resolve(process.cwd(), 'test/fixtures/mock-orchestrated-worker.mjs');
    const actualDiskHash = computeFileSha256(mockWorkerPath);

    // 1. Explicit argument takes highest priority
    const explicitHash = 'a'.repeat(64);
    assert.strictEqual(resolveExecutionScriptHash(mockWorkerPath, explicitHash), explicitHash);

    // 2. Environment variable override takes second priority
    const envHash = 'b'.repeat(64);
    process.env.EXECUTION_PLANE_SHA256 = envHash;
    try {
      assert.strictEqual(resolveExecutionScriptHash(mockWorkerPath, null), envHash);
    } finally {
      delete process.env.EXECUTION_PLANE_SHA256;
    }

    // 3. Manifest/disk resolution returns the real 64-char SHA-256 hash
    const resolved = resolveExecutionScriptHash(mockWorkerPath, null);
    assert.strictEqual(resolved, actualDiskHash);
  });

  await t.test('Pillar 6: AEADStorageAdapter detects and rejects state_version rollback', async () => {
    await StorageAdapter.initDatabase(':memory:');
    await StorageAdapter.commitTransitionWithOCC(0, {
      state: SecurityState.UNINITIALIZED,
      state_version: 0
    }, 'BOOT');

    // Capture the valid encrypted row at state_version = 1
    const snapshotV1 = await StorageAdapter._db.get(
      'SELECT state_version, backend_generation, encrypted_blob FROM secure_state WHERE key = ?',
      ['singleton']
    );
    assert.strictEqual(snapshotV1.state_version, 1);

    // Advance state_version to 2
    await StorageAdapter.commitTransitionWithOCC(1, {
      state: SecurityState.SECURITY_STATE_READY,
      state_version: 1
    }, 'BOOTSTRAP_COMPLETE');

    const currentRow = await StorageAdapter.getSecurityStateRow();
    assert.strictEqual(currentRow.state_version, 2);

    // Simulate a white-box attacker replaying the valid v1 encrypted row + v1 state_version into SQLite
    await StorageAdapter._db.run(
      'UPDATE secure_state SET state_version = ?, backend_generation = ?, encrypted_blob = ? WHERE key = ?',
      [snapshotV1.state_version, snapshotV1.backend_generation, snapshotV1.encrypted_blob, 'singleton']
    );

    await assert.rejects(
      async () => {
        await StorageAdapter.getSecurityStateRow();
      },
      /SECURITY_STATE_UNCERTAIN: State version rollback detected/
    );
  });
});
