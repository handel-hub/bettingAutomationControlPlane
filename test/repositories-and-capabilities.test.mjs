// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAccountsRepo, InMemoryConfigRepo } from '../src/repositories/in-memory/InMemoryRepos.mjs';
import { CapabilityResolver } from '../src/state/capabilityResolver.mjs';
import { WorkspaceAggregator } from '../src/state/workspaceAggregator.mjs';

test('InMemoryAccountsRepo: enforces composite uniqueness on (platform, username)', async () => {
  const repo = new InMemoryAccountsRepo();

  // Seeding includes SportyBet / sporty_pro_01
  await assert.rejects(
    async () => {
      await repo.create({
        platformDisplayName: 'sportybet', // case-insensitive check
        accountUsername: 'SPORTY_PRO_01'
      });
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already exists/);
      return true;
    }
  );

  // New distinct account succeeds
  const created = await repo.create({
    platformDisplayName: 'BetKing',
    accountUsername: 'king_bettor_99'
  });
  assert.equal(created.platformDisplayName, 'BetKing');
  assert.equal(created.accountUsername, 'king_bettor_99');
});

test('CapabilityResolver: accurately reflects lifecycle states and disabled reasons', () => {
  // When STOPPED
  const stoppedCaps = CapabilityResolver.resolve({
    lifecycle: 'STOPPED',
    isAuthorized: true,
    activeBrowsers: 0,
    maxCapacity: 2,
    globalActionPending: null,
    totalConfiguredAccounts: 2
  });

  assert.equal(stoppedCaps.canStartAutomation, true);
  assert.equal(stoppedCaps.canStopAutomation, false);
  assert.equal(stoppedCaps.stopDisabledReason, 'Automation is already stopped');
  assert.equal(stoppedCaps.canPlaceBet, false);
  assert.match(stoppedCaps.placeBetDisabledReason, /must be running/);
  assert.equal(stoppedCaps.canEditProxy, true);

  // When RUNNING with 1 browser
  const runningCaps = CapabilityResolver.resolve({
    lifecycle: 'RUNNING',
    isAuthorized: true,
    activeBrowsers: 1,
    maxCapacity: 2,
    globalActionPending: null,
    totalConfiguredAccounts: 2
  });

  assert.equal(runningCaps.canStartAutomation, false);
  assert.equal(runningCaps.canStopAutomation, true);
  assert.equal(runningCaps.canPlaceBet, true);
  assert.equal(runningCaps.placeBetDisabledReason, undefined);
  assert.equal(runningCaps.canEditProxy, false); // Proxy locked during execution

  // When operation pending
  const pendingCaps = CapabilityResolver.resolve({
    lifecycle: 'RUNNING',
    isAuthorized: true,
    activeBrowsers: 1,
    maxCapacity: 2,
    globalActionPending: 'PLACING_BET',
    totalConfiguredAccounts: 2
  });

  assert.equal(pendingCaps.canPlaceBet, false);
  assert.match(pendingCaps.placeBetDisabledReason, /Operation in progress/);
});

test('WorkspaceAggregator: compiles complete workspace snapshot', async () => {
  const aggregator = new WorkspaceAggregator();
  const snapshot = await aggregator.getSnapshot();

  assert.equal(snapshot.lifecycle, 'STOPPED');
  assert.ok(snapshot.capabilities);
  assert.ok(snapshot.globalConfig);
  assert.ok(snapshot.globalConfig.pricing);
  assert.ok(Array.isArray(snapshot.accounts));
  assert.ok(snapshot.accounts.length >= 2);
  assert.equal(snapshot.systemStatus.acpConnected, true);
});
