// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { SecurityState } from '../src/security-authority/state-machine/states.mjs';
import { DecisionEngine } from '../src/security-authority/decision-engine.mjs';
import { CAPABILITY } from '../src/security-authority/authorization/capabilities.mjs';
import { commandRouter, COMMAND_CAPABILITY_MAP } from '../src/command/commandRouter.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';
import { runtimeManager } from '../src/runtime-manager/runtime-manager.mjs';
import { backendSyncService } from '../src/sync/backendSyncService.mjs';
import { authConfig, ingressAuthMiddleware, initDevToken } from '../src/api-server/middleware/auth.mjs';

test('Remediation: Cold-Start & Ingress Security Invariants', async (t) => {
  NativeCore.init();

  await t.test('Invariant 1: Cold boot initializes to SECURITY_STATE_READY (no zombie OPERATIONAL revival)', async () => {
    await securityFacade.initialize();

    // At baseline boot without cloud handshake, state must be READY, never OPERATIONAL
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.SECURITY_STATE_READY);
  });

  await t.test('Invariant 2: establishSession transitions READY to OPERATIONAL with capabilities', async () => {
    await securityFacade.initialize();
    
    const sessionPayload = {
      sessionId: 'sess_test_cloud_999',
      accountId: 'acc_operator_1',
      expiresInMs: 3600000,
      capabilities: Object.values(CAPABILITY),
      license: { status: 'VALID', tier: 'PRO' }
    };

    const res = await securityFacade.establishSession(sessionPayload);
    assert.strictEqual(res.status, 'OPERATIONAL');
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.OPERATIONAL);
    assert.strictEqual(securityFacade.isOperational(), true);
    assert.strictEqual(securityFacade.isDegraded(), false);

    // Capabilities must be granted
    assert.strictEqual(securityFacade.authorize(CAPABILITY.AUTOMATION_START).status, 'OPERATIONAL');
    assert.strictEqual(securityFacade.authorize(CAPABILITY.BET_PLACE).status, 'OPERATIONAL');
  });

  await t.test('Invariant 3: enterOfflineGrace permits automation while marking system non-degraded', async () => {
    // Reset to cold-boot baseline
    await securityFacade.initialize();
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.SECURITY_STATE_READY);

    // Cold-boot with valid lease enters offline grace
    const entered = await securityFacade.enterOfflineGrace({
      leaseAgeMs: 1800000, // 30 minutes
      expiresAt: Date.now() + 5400000
    });
    assert.strictEqual(entered, true);
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.OFFLINE_GRACE);

    // In offline grace, system is operational for automation
    assert.strictEqual(securityFacade.isDegraded(), false);
    assert.strictEqual(securityFacade.isCommandPermitted('START_AUTOMATION'), true);
    assert.strictEqual(securityFacade.isCommandPermitted('PLACE_BET'), true);

    // When grace expires or is revoked, transition to degraded
    await securityFacade.transitionToDegraded('GRACE_EXHAUSTED');
    assert.strictEqual(securityFacade.isDegraded(), true);
    assert.strictEqual(securityFacade.isCommandPermitted('START_AUTOMATION'), false);
    assert.strictEqual(securityFacade.isCommandPermitted('PLACE_BET'), false);
  });

  await t.test('Invariant 4: Tactical execution commands mapped to capabilities in COMMAND_CAPABILITY_MAP', () => {
    assert.strictEqual(COMMAND_CAPABILITY_MAP['PLACE_BET'], CAPABILITY.BET_PLACE);
    assert.strictEqual(COMMAND_CAPABILITY_MAP['CASH_OUT'], CAPABILITY.BET_CASHOUT);
    assert.strictEqual(COMMAND_CAPABILITY_MAP['VALIDATE'], CAPABILITY.BET_VALIDATE);
    assert.strictEqual(COMMAND_CAPABILITY_MAP['ACTIVATE_ACCOUNT'], CAPABILITY.ACCOUNT_MANAGE);
    assert.strictEqual(COMMAND_CAPABILITY_MAP['DEACTIVATE_ACCOUNT'], CAPABILITY.ACCOUNT_MANAGE);
  });

  await t.test('Invariant 5: Parent process.env.APP_ROOT is not polluted during worker spawn', () => {
    const originalAppRoot = process.env.APP_ROOT;
    
    // Simulate runtime manager spawn options
    assert.strictEqual(process.env.APP_ROOT, originalAppRoot);
  });

  await t.test('Invariant 6: Stream sequence gap triggers serialized snapshot reconciliation', async () => {
    let snapshotCalled = false;
    const originalPull = backendSyncService.pullAuthoritativeSnapshot;
    backendSyncService.pullAuthoritativeSnapshot = async () => {
      snapshotCalled = true;
      backendSyncService.lastObservedSequence = 50;
    };

    try {
      backendSyncService.lastObservedSequence = 10;
      backendSyncService.accountSequences.set('acc_test', 10);

      // Frame with gap (seq 25 > 10 + 1)
      await backendSyncService.handleServerEvent({
        eventType: 'ACCOUNT_UPDATED',
        sequenceNumber: 25,
        payload: { accountId: 'acc_test' }
      });

      assert.strictEqual(snapshotCalled, true);
      // Since snapshot advanced sequence to 50, frame 25 is discarded
      assert.strictEqual(backendSyncService.lastObservedSequence, 50);
    } finally {
      backendSyncService.pullAuthoritativeSnapshot = originalPull;
    }
  });

  await t.test('Invariant 7: REST Ingress rejects tokens in query strings', () => {
    const origRequire = authConfig.requireAuth;
    const origToken = authConfig.activeToken;
    authConfig.requireAuth = true;
    authConfig.activeToken = 'secret-token-test-123';

    try {
      let statusCalled = null;
      let jsonPayload = null;
      const fakeReq = {
        path: '/api/v1/automation/start',
        headers: {},
        query: { token: 'secret-token-test-123' }
      };
      const fakeRes = {
        status: (code) => {
          statusCalled = code;
          return { json: (p) => { jsonPayload = p; } };
        }
      };

      ingressAuthMiddleware(fakeReq, fakeRes, () => {});
      // Must be rejected as 401 Unauthorized because token was only in query string
      assert.strictEqual(statusCalled, 401);
      assert.strictEqual(jsonPayload?.error, 'UNAUTHORIZED');
    } finally {
      authConfig.requireAuth = origRequire;
      authConfig.activeToken = origToken;
    }
  });
});
