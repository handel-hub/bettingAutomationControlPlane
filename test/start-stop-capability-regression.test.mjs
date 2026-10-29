import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { operationTracker } from '../src/state/operationTracker.mjs';
import { workspaceAggregator } from '../src/state/workspaceAggregator.mjs';
import { repositoryFactory } from '../src/repositories/repositoryFactory.mjs';
import { StateStore } from '../src/state-store/StateStore.mjs';
import { getSharedStateStore, setSharedStateStore, resetSharedStateStore } from '../src/state-store/sharedStateStore.mjs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { BackendClient } from '../src/security-authority/protocol/backend-client.mjs';
import { BackendSyncService } from '../src/sync/backendSyncService.mjs';
import { ExecutionPayloadBuilder } from '../src/runtime-manager/boundary/ExecutionPayloadBuilder.mjs';
import { vaultCredentialPipeline } from '../src/runtime-manager/boundary/VaultCredentialPipeline.mjs';

describe('Start -> CashOut -> Stop Capability, Header & Credential Hydration Regression Suite', () => {
  beforeEach(async () => {
    resetSharedStateStore();
    const memoryStore = new StateStore({ dbPath: ':memory:', userId: 'usr_regression_test' });
    memoryStore.initialize();
    setSharedStateStore(memoryStore);

    await securityFacade.initialize(':memory:');
    operationTracker.operations.clear();
    vaultCredentialPipeline.clear();
    workspaceAggregator.stagedAccountIds.clear();
    workspaceAggregator.activeAccountIds.clear();

    const accountsRepo = repositoryFactory.getAccountsRepo();
    await accountsRepo.create({
      id: 'acc-regression-1',
      name: 'SportyBet Pro 1',
      platformId: 'sportybet',
      platformDisplayName: 'SportyBet',
      accountUsername: 'pro_user_1',
      accountPassword: 'ValidRegressionPassword123!',
      backendState: 'IDLE',
      desiredState: 'STOPPED',
      observedState: 'STOPPED'
    });
    workspaceAggregator.stageAccount('acc-regression-1');

    await securityFacade.establishSession({
      sessionId: '00000000-0000-4000-8000-000000000111',
      sessionGeneration: 1,
      capabilities: ['CAP_AUTOMATION_START', 'CAP_AUTOMATION_STOP', 'CAP_CASH_OUT', 'CAP_TACTICAL_BET'],
      license: {
        licenseId: 'lic-pro-reg',
        status: 'VALID',
        planId: 'pro',
        capabilities: ['CAP_AUTOMATION_START', 'CAP_AUTOMATION_STOP', 'CAP_CASH_OUT', 'CAP_TACTICAL_BET']
      }
    });
    workspaceAggregator.setLifecycle('STOPPED');
  });

  it('1. Reproduces and verifies fix for NEW-CP-011, CP-005, and NEW-CP-014 (Start -> CashOut -> Stop -> Restart Ready)', async () => {
    const store = getSharedStateStore();
    assert.equal(store.dbPath, ':memory:', 'Test suite must run strictly against :memory: SQLite');

    // Initial STOPPED state: Pro user can start automation
    const initialSnap = await workspaceAggregator.getSnapshot();
    assert.equal(initialSnap.lifecycle, 'STOPPED');
    assert.equal(initialSnap.capabilities.canStartAutomation, true);
    assert.equal(initialSnap.capabilities.startDisabledReason, undefined);

    // 1. Start Automation
    workspaceAggregator.startAutomation();
    if (store?.accounts?.recordHeartbeat) {
      store.accounts.recordHeartbeat('acc-regression-1', 'ACTIVE');
    }

    const runningSnap = await workspaceAggregator.getSnapshot();
    assert.equal(runningSnap.lifecycle, 'RUNNING');
    assert.equal(runningSnap.capabilities.canStartAutomation, false);
    // CP-005: Must say "Automation is already running", NOT "Missing capability: CAP_AUTOMATION_START"
    assert.equal(runningSnap.capabilities.startDisabledReason, 'Automation is already running');
    assert.equal(runningSnap.capabilities.canStopAutomation, true);

    // 2. Initiate CASH_OUT operation
    const op = operationTracker.startOperation('CASHING_OUT', { accountId: 'acc-regression-1', mode: 'full' });
    assert.equal(operationTracker.getCurrentPendingAction(), 'CASHING_OUT');

    // Even while CASH_OUT is pending, canStopAutomation MUST remain true
    const duringCashOutSnap = await workspaceAggregator.getSnapshot();
    assert.equal(duringCashOutSnap.capabilities.canStopAutomation, true);

    // 3. Complete CASH_OUT operation via completeOperation (wired to OPERATION_RESULT in index.mjs)
    operationTracker.completeOperation(op.operationId, { cashedOut: true });
    assert.equal(operationTracker.operations.get(op.operationId).status, 'COMPLETED');
    assert.equal(operationTracker.getCurrentPendingAction(), null);

    // 4. Create another pending operation to simulate an unacknowledged operation when Stop is clicked
    const strandedOp = operationTracker.startOperation('CASHING_OUT', { accountId: 'acc-regression-1', mode: 'full' });
    assert.equal(operationTracker.getCurrentPendingAction(), 'CASHING_OUT');

    // 5. Stop Automation -> must clear pending operations and reset account states to STOPPED
    workspaceAggregator.stopAutomation();
    assert.equal(operationTracker.getCurrentPendingAction(), null);
    assert.equal(operationTracker.operations.get(strandedOp.operationId).status, 'FAILED');

    const postStopSnap = await workspaceAggregator.getSnapshot();
    assert.equal(postStopSnap.lifecycle, 'STOPPED');
    assert.equal(postStopSnap.capabilities.canStartAutomation, true);
    assert.equal(postStopSnap.capabilities.startDisabledReason, undefined);
    assert.equal(postStopSnap.accounts[0].desiredState, 'STOPPED');
    assert.equal(postStopSnap.accounts[0].observedState, 'STOPPED');
  });

  it('2. Verifies NEW-CP-012 & CP-008: BackendClient attaches Authorization & x-session-id headers on getPlatformRegistry, updateGlobalConfig, and toggleBetCycle', async () => {
    const client = new BackendClient('http://127.0.0.1:8080');
    client.setSession('00000000-0000-4000-8000-000000000222', 1);

    /** @type {Array<{ url: string, options: any }>} */
    const capturedCalls = [];
    client._fetchWithPinning = async (url, options) => {
      capturedCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: new Map([['etag', '"v1"']]),
        json: async () => ({ platforms: [] })
      };
    };

    await client.getPlatformRegistry();
    await client.updateGlobalConfig('pricing', { targetProfit: 40 });
    await client.toggleBetCycle('acc-regression-1', true);

    assert.equal(capturedCalls.length, 3);
    for (const call of capturedCalls) {
      assert.equal(call.options.headers['Authorization'], 'Bearer 00000000-0000-4000-8000-000000000222');
      assert.equal(call.options.headers['x-session-id'], '00000000-0000-4000-8000-000000000222');
    }
  });

  it('3. Verifies NEW-CP-012: pullPublicCatalogs skips /api/v1/platforms when unauthenticated and fetches it when sessionId is present', async () => {
    let platformCalled = 0;
    let plansCalled = 0;
    const mockClient = {
      sessionId: null,
      getPlatformRegistry: async () => {
        platformCalled++;
        return { notModified: false, registry: { platforms: [] }, etag: 'e1' };
      },
      getPlansCatalog: async () => {
        plansCalled++;
        return { notModified: false, catalog: { plans: [] }, etag: 'e2' };
      }
    };

    const syncService = new BackendSyncService({ client: /** @type {any} */ (mockClient), enableWebSocket: false });
    await syncService.pullPublicCatalogs();
    assert.equal(platformCalled, 0, 'Should not call getPlatformRegistry when sessionId is null');
    assert.equal(plansCalled, 1, 'Should call getPlansCatalog when sessionId is null');

    mockClient.sessionId = '00000000-0000-4000-8000-000000000333';
    await syncService.pullPublicCatalogs();
    assert.equal(platformCalled, 1, 'Should call getPlatformRegistry when sessionId is present');
    assert.equal(plansCalled, 2);
  });

  it('4. Verifies Backend-to-Control-Plane credential hydration prevents [CREDENTIAL_MISSING] when local cache lacks password', async () => {
    const store = getSharedStateStore();
    vaultCredentialPipeline.clear();

    // Simulate an account in local StateStore whose local password was wiped/masked
    store.accounts.replaceAll([
      {
        id: 'ee6a62cc-c9fe-4a8c-8932-e25e92728bf6',
        name: 'SportyBet - 08067668997',
        platformDisplayName: 'SportyBet',
        accountUsername: '08067668997',
        accountPassword: '********',
        backendState: 'ACTIVE'
      }
    ]);

    assert.equal(
      ExecutionPayloadBuilder.resolvePassword(store.accounts.getById('ee6a62cc-c9fe-4a8c-8932-e25e92728bf6'), store),
      '',
      'Password should initially be empty before authoritative hydration'
    );

    // Simulate BackendSyncService.pullAuthoritativeSnapshot() where:
    // - getAutomationSnapshot() returns the decrypted password from Backend vault
    // - getBettingAccounts() subsequently returns masked '********'
    const mockClient = {
      sessionId: '00000000-0000-4000-8000-000000000444',
      getAutomationSnapshot: async () => ({
        globalConfig: {},
        accounts: [
          {
            id: 'ee6a62cc-c9fe-4a8c-8932-e25e92728bf6',
            name: 'SportyBet - 08067668997',
            platformDisplayName: 'SportyBet',
            accountUsername: '08067668997',
            accountPassword: 'RecoveredVaultPassword99!',
            backendState: 'ACTIVE'
          }
        ]
      }),
      getBettingAccounts: async () => ({
        viewportAccounts: [
          {
            id: 'ee6a62cc-c9fe-4a8c-8932-e25e92728bf6',
            name: 'SportyBet - 08067668997',
            platformDisplayName: 'SportyBet',
            accountUsername: '08067668997',
            accountPassword: '********',
            backendState: 'ACTIVE'
          }
        ]
      }),
      getBillingSnapshot: async () => null,
      getPlatformRegistry: async () => ({ notModified: true }),
      getPlansCatalog: async () => ({ notModified: true })
    };

    const syncService = new BackendSyncService({ client: /** @type {any} */ (mockClient), enableWebSocket: false });
    await syncService.pullAuthoritativeSnapshot();

    // Verify ExecutionPayloadBuilder.buildInitializationPayload() now succeeds and resolves the password
    const initPayload = ExecutionPayloadBuilder.buildInitializationPayload(store, 'trace-cred-hydrate-1');
    assert.equal(initPayload.accounts.length, 1);
    assert.equal(initPayload.accounts[0].username, '08067668997');
    assert.equal(initPayload.accounts[0].password, 'RecoveredVaultPassword99!');
  });
});
