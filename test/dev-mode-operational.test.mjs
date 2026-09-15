// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { executionAuthorization } from '../src/runtime-manager/execution-authorization.mjs';
import { CAPABILITY } from '../src/security-authority/authorization/capabilities.mjs';
import { SecurityState } from '../src/security-authority/state-machine/states.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';
import { runtimeManager } from '../src/runtime-manager/runtime-manager.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';

test('Local Developer Operational Mode Boundary & Invariants', async (t) => {
  NativeCore.init();

  await t.test('initDevSession provisions full capabilities and OPERATIONAL state', async () => {
    // 1. Initialize facade
    await securityFacade.initialize();

    // 2. Call initDevSession
    await securityFacade.initDevSession();

    // 3. Verify state
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.OPERATIONAL);
    assert.strictEqual(securityFacade.isOperational(), true);
    assert.strictEqual(securityFacade.isDegraded(), false);
    assert.strictEqual(securityFacade.isSessionRevokedSync(), false);

    // 4. Verify all canonical capabilities are granted
    for (const cap of Object.values(CAPABILITY)) {
      const authz = securityFacade.authorize(cap);
      assert.strictEqual(
        authz.status,
        'OPERATIONAL',
        `Capability ${cap} must be granted in Local Developer Operational Mode`
      );
    }

    // 5. Verify execution authorization
    assert.strictEqual(executionAuthorization.canStartAutomation(), true);
  });

  await t.test('SEC_001 invariant holds: active runtime dynamically masks CAP_AUTOMATION_START', async () => {
    await securityFacade.initDevSession();
    securityFacade.setActiveExecutionChecker(() => runtimeManager.activeRuntimes.size > 0);

    // With zero active runtimes
    runtimeManager.activeRuntimes.clear();
    const canStartBefore = securityFacade.authorize(CAPABILITY.AUTOMATION_START);
    assert.strictEqual(canStartBefore.status, 'OPERATIONAL');

    // Simulate active runtime
    runtimeManager.activeRuntimes.add(99999);
    const canStartAfter = securityFacade.authorize(CAPABILITY.AUTOMATION_START);
    assert.strictEqual(canStartAfter.status, 'DENIED');

    runtimeManager.activeRuntimes.clear();
  });

  await t.test('Degraded mode can still be explicitly triggered and tested', async () => {
    await securityFacade.initDevSession();
    assert.strictEqual(securityFacade.isDegraded(), false);

    // Transition to degraded
    await securityFacade.transitionToDegraded('EXPLICIT_TEST_DEGRADATION');
    assert.strictEqual(securityFacade.isDegraded(), true);
    assert.strictEqual(securityFacade.isOperational(), false);

    // Re-activating dev session restores operational status
    await securityFacade.initDevSession();
    assert.strictEqual(securityFacade.isOperational(), true);
    assert.strictEqual(securityFacade.isDegraded(), false);
  });
});
