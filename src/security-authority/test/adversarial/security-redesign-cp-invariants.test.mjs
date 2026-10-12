// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { licenseManager } from '../../licensing/license-manager.mjs';
import { NativeCore } from '../../native/security-core.mjs';
import { CanonicalSerializer } from '../../protocol/canonical-serializer.mjs';
import { BackendSyncService } from '../../../sync/backendSyncService.mjs';
import { StateStore } from '../../../state-store/StateStore.mjs';
import { clock } from '../../time/clock.mjs';

test('SEC-INV-09 (REM-06 & REM-07): Control Plane production license guard, offline GraceToken verification, migration 006 password encryption, and removal of hardcoded re-auth credentials', async (t) => {
  await t.test('1. REM-06a: LicenseManager blocks ALLOW_DEV_LICENSE and VALID_SIG in production', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_DEV_LICENSE;
    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_DEV_LICENSE = 'true';

      const accepted = licenseManager.validateLicenseIntegrity({
        accountId: 'acc-1',
        status: 'ACTIVE',
        signature: 'VALID_SIG'
      });
      assert.strictEqual(accepted, false, 'VALID_SIG dev bypass must be rejected in production even if ALLOW_DEV_LICENSE=true');
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevAllow === undefined) delete process.env.ALLOW_DEV_LICENSE;
      else process.env.ALLOW_DEV_LICENSE = prevAllow;
    }
  });

  await t.test('2. REM-06b: LicenseManager and BackendSyncService cryptographically verify offline GraceToken and reject forged tokens', async () => {
    const kp = NativeCore.generateEd25519Keypair();
    const now = Date.now();
    const tokenPayload = {
      account_id: 'acc-grace-test',
      machine_id: 'mach-grace-test',
      capabilities: ['CAP_AUTOMATION_START'],
      issued_at: now,
      not_before: now - 1000,
      not_after: now + 3600_000
    };
    const canonical = CanonicalSerializer.canonicalStringify(tokenPayload);
    const sigHex = NativeCore.signEd25519(kp.privateKey, Buffer.from(canonical, 'utf8'));

    const validGraceToken = {
      ...tokenPayload,
      signature: sigHex,
      key_version: 1
    };

    const prevPinned = process.env.PINNED_BACKEND_PUBKEY_HEX;
    try {
      process.env.PINNED_BACKEND_PUBKEY_HEX = kp.publicKey;
      assert.strictEqual(licenseManager.verifyGraceToken(validGraceToken), true, 'Valid signed GraceToken must verify');

      // Tamper with capabilities
      const forgedGraceToken = {
        ...validGraceToken,
        capabilities: ['CAP_AUTOMATION_START', 'CAP_SUPER_ADMIN']
      };
      assert.strictEqual(licenseManager.verifyGraceToken(forgedGraceToken), false, 'Tampered GraceToken must be rejected');

      // BackendSyncService.getOfflineGraceLease must reject forged GraceToken
      await clock.updateAnchor(Date.now());
      const syncSvc = new BackendSyncService({ enableWebSocket: false });
      syncSvc.lastSyncTimestamp = new Date().toISOString();
      syncSvc.lastGraceToken = validGraceToken;
      assert.ok(syncSvc.getOfflineGraceLease(), 'Valid GraceToken must grant offline grace lease');

      syncSvc.lastGraceToken = forgedGraceToken;
      assert.strictEqual(syncSvc.getOfflineGraceLease(), null, 'Forged GraceToken must deny offline grace lease');
    } finally {
      if (prevPinned === undefined) delete process.env.PINNED_BACKEND_PUBKEY_HEX;
      else process.env.PINNED_BACKEND_PUBKEY_HEX = prevPinned;
    }
  });

  await t.test('3. REM-06c: Migration 006 encrypts pre-existing plaintext passwords in SQLite at rest', () => {
    const tmpDbPath = path.join(os.tmpdir(), `acp_mig006_${Date.now()}.db`);
    t.after(() => {
      try {
        if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
        if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
        if (fs.existsSync(`${tmpDbPath}-shm`)) fs.unlinkSync(`${tmpDbPath}-shm`);
      } catch { /* ignore */ }
    });

    const store = new StateStore({ dbPath: tmpDbPath, userId: 'usr_mig006' });
    store.initialize();

    // Simulate a legacy pre-006 row with plaintext password and version 5
    const legacyPlainPassword = 'LegacyPlaintextPassword#99!';
    store.engine.prepare(`
      INSERT INTO accounts_metadata_cache (
        account_id, user_id, name, platform_id, platform_display_name, account_username, account_password,
        last_known_balance, currency_symbol, backend_state, presentation_category, status_description,
        tags_json, last_updated, last_synchronization
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '₦', 'ACTIVE', 'Healthy', 'OK', '[]', ?, ?)
    `).run(
      'acc_legacy_plain',
      'usr_mig006',
      'Legacy Account',
      'sportybet',
      'SportyBet',
      'legacy_user',
      legacyPlainPassword,
      new Date().toISOString(),
      new Date().toISOString()
    );
    store.engine.userVersion(5);

    // Re-run migrator from version 5 -> 6
    const newVersion = store.migrator.migrate();
    assert.strictEqual(newVersion, 6);

    const row = store.engine.prepare('SELECT account_password FROM accounts_metadata_cache WHERE account_id = ?').get('acc_legacy_plain');
    assert.ok(row.account_password.startsWith('enc:v1:'), 'Migration 006 must encrypt legacy plaintext password');
    assert.strictEqual(store.accounts.getRawPassword('acc_legacy_plain'), legacyPlainPassword, 'Encrypted password must decrypt to original');
    store.close();
  });

  await t.test('4. REM-07: BackendSyncService does not call initAuth with hardcoded operator@bettingautomation.io on GENERATION_MISMATCH', async () => {
    const prevEmail = process.env.OPERATOR_EMAIL;
    const prevPass = process.env.OPERATOR_PASSWORD;
    delete process.env.OPERATOR_EMAIL;
    delete process.env.OPERATOR_PASSWORD;

    try {
      let initAuthCalled = false;
      const mockClient = {
        initAuth: async () => {
          initAuthCalled = true;
          return {};
        },
        updateGlobalConfig: async () => {
          const err = new Error('GENERATION_MISMATCH');
          // @ts-ignore
          err.code = 'BE_REV_GENERATION_MISMATCH';
          throw err;
        }
      };

      const syncSvc = new BackendSyncService({
        // @ts-ignore
        client: mockClient,
        enableWebSocket: false
      });
      syncSvc.isConnected = true;

      await syncSvc.syncMutation('UPDATE_GLOBAL_CONFIG', { category: 'pricing', values: { minOdds: 1.5 } });
      assert.strictEqual(initAuthCalled, false, 'initAuth must NOT be called with hardcoded credentials when OPERATOR_EMAIL/PASSWORD are unset');
    } finally {
      if (prevEmail !== undefined) process.env.OPERATOR_EMAIL = prevEmail;
      if (prevPass !== undefined) process.env.OPERATOR_PASSWORD = prevPass;
    }
  });
});
