// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendSyncService } from '../../src/sync/backendSyncService.mjs';
import { SqliteStorageEngine } from '../../src/state-store/persistence/SqliteStorageEngine.mjs';

test('Track C: Persistent Backend Mutation Retry Outbox (Phases 4 & 13)', async (t) => {
  await t.test('enqueues mutations into retry outbox when Cloud Backend is offline', async () => {
    // Mock backendClient
    const mockClient = {
      endpoint: 'http://localhost:8080',
      sessionId: null,
      checkHealth: async () => ({ ok: false, status: 503 })
    };

    const syncService = new BackendSyncService({
      // @ts-ignore
      client: mockClient,
      enableWebSocket: false
    });

    syncService.isConnected = false;

    // Dispatch mutation while offline
    const res = await syncService.syncMutation('UPDATE_GLOBAL_CONFIG', {
      category: 'Staking',
      values: { maxStakePerBet: 1000 }
    });

    assert.strictEqual(res.localOnly, true);
    assert.strictEqual(res.queuedForRetry, true);
    assert.ok(res.outboxId);
    assert.strictEqual(syncService.outbox.length, 1);
    assert.strictEqual(syncService.outbox[0].mutationType, 'UPDATE_GLOBAL_CONFIG');
    assert.strictEqual(syncService.outbox[0].attempts, 0);
  });

  await t.test('flushOutbox synchronizes all pending mutations when connectivity is restored', async () => {
    let globalConfigUpdated = null;
    let accountCreated = null;

    const mockClient = {
      endpoint: 'http://localhost:8080',
      sessionId: 'sess_valid_123',
      updateGlobalConfig: async (category, values) => {
        globalConfigUpdated = { category, values };
        return { success: true };
      },
      createBettingAccount: async (payload) => {
        accountCreated = payload;
        return { id: 'acc_cloud_1' };
      }
    };

    const syncService = new BackendSyncService({
      // @ts-ignore
      client: mockClient,
      enableWebSocket: false
    });

    // Enqueue 2 mutations while offline
    syncService.isConnected = false;
    await syncService.syncMutation('UPDATE_GLOBAL_CONFIG', {
      category: 'Risk',
      values: { dailyStopLoss: 5000 }
    });
    await syncService.syncMutation('REGISTER_ACCOUNT', {
      platformDisplayName: 'Bet9ja',
      accountUsername: 'user123',
      accountPassword: 'SecretPassword123!'
    });

    assert.strictEqual(syncService.outbox.length, 2);

    // Connectivity restored
    syncService.isConnected = true;
    const flushRes = await syncService.flushOutbox();

    assert.strictEqual(flushRes.flushed, 2);
    assert.strictEqual(flushRes.remaining, 0);
    assert.strictEqual(syncService.outbox.length, 0);
    assert.deepStrictEqual(globalConfigUpdated, { category: 'Risk', values: { dailyStopLoss: 5000 } });
    assert.strictEqual(accountCreated?.accountPassword, 'SecretPassword123!');
  });

  await t.test('schedules exponential backoff on client error during flushOutbox', async () => {
    let attemptsCount = 0;
    const mockClient = {
      endpoint: 'http://localhost:8080',
      sessionId: 'sess_valid_123',
      cancelSubscription: async () => {
        attemptsCount++;
        throw new Error('500 Internal Server Error from Billing API');
      }
    };

    const syncService = new BackendSyncService({
      // @ts-ignore
      client: mockClient,
      enableWebSocket: false
    });

    syncService.isConnected = false;
    await syncService.syncMutation('CANCEL_SUBSCRIPTION', {});

    assert.strictEqual(syncService.outbox.length, 1);
    assert.strictEqual(syncService.outbox[0].attempts, 0);

    // Online, but remote server errors
    syncService.isConnected = true;
    const flushRes = await syncService.flushOutbox();

    assert.strictEqual(flushRes.flushed, 0);
    assert.strictEqual(flushRes.remaining, 1);
    assert.strictEqual(attemptsCount, 1);
    assert.strictEqual(syncService.outbox[0].attempts, 1);
    assert.ok(syncService.outbox[0].nextRetryAt > Date.now());
    assert.strictEqual(syncService.outbox[0].lastError, '500 Internal Server Error from Billing API');
  });

  await t.test('outbox entries persist across restarts when SQLite storage engine is configured', async () => {
    const engine = new SqliteStorageEngine(':memory:');
    engine.open();

    const mockClient = {
      endpoint: 'http://localhost:8080',
      sessionId: null
    };

    // 1. Instance 1 enqueues while offline
    const service1 = new BackendSyncService({
      // @ts-ignore
      client: mockClient,
      enableWebSocket: false,
      engine
    });
    service1.isConnected = false;

    await service1.syncMutation('UPDATE_GLOBAL_CONFIG', {
      category: 'Spawning',
      values: { maxAccountsToSpawn: 6 }
    });

    assert.strictEqual(service1.outbox.length, 1);

    // 2. Instance 2 boots up with the same SQLite engine
    const service2 = new BackendSyncService({
      // @ts-ignore
      client: mockClient,
      enableWebSocket: false,
      engine
    });

    // Invariant: Unsent outbox items MUST be hydrated from SQLite!
    assert.strictEqual(service2.outbox.length, 1);
    assert.strictEqual(service2.outbox[0].mutationType, 'UPDATE_GLOBAL_CONFIG');
    assert.deepStrictEqual(service2.outbox[0].payload, {
      category: 'Spawning',
      values: { maxAccountsToSpawn: 6 }
    });

    engine.close();
  });
});
