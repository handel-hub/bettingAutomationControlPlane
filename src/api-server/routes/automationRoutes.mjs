// @ts-check
import { Router } from 'express';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { operationTracker } from '../../state/operationTracker.mjs';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { CAPABILITY } from '../../security-authority/authorization/capabilities.mjs';
import { wsServer } from '../websocket/wsServer.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { DEFAULT_STRATEGY_CATALOG } from '../../state-store/types/contracts.mjs';

export const automationRouter = Router();

// GET full workspace snapshot
automationRouter.get('/snapshot', async (req, res) => {
  try {
    const store = getSharedStateStore();
    const runtimeState = {
      lifecycle: workspaceAggregator.lifecycle,
      lifecycleMessage: workspaceAggregator.lifecycleMessage,
      activeAccountIds: workspaceAggregator.activeAccountIds,
      stagedAccountIds: workspaceAggregator.stagedAccountIds,
      activeBrowsers: workspaceAggregator.activeAccountIds.size,
      globalActionPending: operationTracker.getCurrentPendingAction()
    };
    const snapshot = store.getWorkspaceSnapshot(runtimeState);
    res.setHeader('X-Protocol-Version', '2.0');
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET strategy options catalog
automationRouter.get('/strategy-catalog', (req, res) => {
  try {
    const store = getSharedStateStore();
    const catalog = store.catalogs.getStrategyCatalog() || DEFAULT_STRATEGY_CATALOG;
    res.setHeader('X-Protocol-Version', '2.0');
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST start automation
automationRouter.post('/start', async (req, res) => {
  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'START_AUTOMATION',
    capability: CAPABILITY.AUTOMATION_START,
    onSuccess: async () => {
      workspaceAggregator.startAutomation();
      const snapshot = await workspaceAggregator.getSnapshot();
      wsServer.broadcast('automation:delta', {
        type: 'LIFECYCLE_CHANGED',
        lifecycle: 'RUNNING',
        message: 'Automation engine operational and active'
      });
      wsServer.broadcast('automation:delta', {
        type: 'CAPABILITIES_CHANGED',
        capabilities: snapshot.capabilities
      });
      wsServer.broadcast('automation:snapshot', snapshot);
      res.json({ success: true, lifecycle: 'RUNNING', snapshot });
    }
  });
});

// POST stop automation
automationRouter.post('/stop', async (req, res) => {
  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'STOP_AUTOMATION',
    capability: CAPABILITY.AUTOMATION_STOP,
    onSuccess: async () => {
      workspaceAggregator.stopAutomation();
      const snapshot = await workspaceAggregator.getSnapshot();
      wsServer.broadcast('automation:delta', {
        type: 'LIFECYCLE_CHANGED',
        lifecycle: 'STOPPED',
        message: 'Automation engine standby'
      });
      wsServer.broadcast('automation:delta', {
        type: 'CAPABILITIES_CHANGED',
        capabilities: snapshot.capabilities
      });
      wsServer.broadcast('automation:snapshot', snapshot);
      res.json({ success: true, lifecycle: 'STOPPED', snapshot });
    }
  });
});

// POST tactical place-bet
automationRouter.post('/operations/place-bet', async (req, res) => {
  const { marketId, odds, stake, idempotencyKey, accountId, targetAccounts, forceRetry } = req.body || {};
  const op = operationTracker.startOperation('PLACING_BET', { marketId, odds, stake, idempotencyKey, accountId, traceId: req.traceId });

  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: 'PLACING_BET' }
  }, { correlationId: op.operationId, traceId: req.traceId });

  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'PLACE_BET',
    payload: { marketId, odds, stake, idempotencyKey, accountId, targetAccounts, forceRetry, operationId: op.operationId, traceId: req.traceId },
    onSuccess: (result) => {
      if (result && result.duplicate) {
        return res.status(200).json(result);
      }
      // Return 202 Accepted / QUEUED status per contract
      res.status(202).json({ operationId: op.operationId, status: 'QUEUED', ...result });
    }
  });
});

// POST tactical cash-out
automationRouter.post('/operations/cash-out', async (req, res) => {
  const { betId, threshold, idempotencyKey, accountId, targetAccount, forceRetry } = req.body || {};
  const op = operationTracker.startOperation('CASHING_OUT', { betId, threshold, idempotencyKey, accountId, traceId: req.traceId });

  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: 'CASHING_OUT' }
  }, { correlationId: op.operationId, traceId: req.traceId });

  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'CASH_OUT',
    payload: { betId, threshold, idempotencyKey, accountId, targetAccount, forceRetry, operationId: op.operationId, traceId: req.traceId },
    onSuccess: (result) => {
      if (result && result.duplicate) {
        return res.status(200).json(result);
      }
      res.status(202).json({ operationId: op.operationId, status: 'QUEUED', ...result });
    }
  });
});

// POST tactical validate
automationRouter.post('/operations/validate', async (req, res) => {
  const op = operationTracker.startOperation('VALIDATING');
  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'VALIDATE',
    payload: { operationId: op.operationId },
    onSuccess: () => {
      operationTracker.completeOperation(op.operationId, { valid: true });
      res.json({ status: 'VALID', activeCount: workspaceAggregator.activeAccountIds.size });
    }
  });
});

// POST activate account
automationRouter.post('/accounts/activate', async (req, res) => {
  const { id, name, platformDisplayName, accountUsername } = req.body || {};
  const targetId = id || 'acc-1';

  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'ACTIVATE_ACCOUNT',
    target: targetId,
    payload: { id: targetId, name, platformDisplayName, accountUsername },
    onSuccess: async () => {
      workspaceAggregator.activateAccount(targetId);
      const snapshot = await workspaceAggregator.getSnapshot();
      const account = snapshot.accounts.find(a => a.id === targetId);
      if (account) {
        wsServer.broadcast('automation:delta', {
          type: 'ACCOUNT_ACTIVATED',
          account
        });
      }
      res.json({ account });
    }
  });
});

// POST deactivate account
automationRouter.post('/accounts/:id/deactivate', async (req, res) => {
  const accountId = req.params.id;

  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'DEACTIVATE_ACCOUNT',
    target: accountId,
    payload: { accountId },
    onSuccess: () => {
      workspaceAggregator.deactivateAccount(accountId);
      wsServer.broadcast('automation:delta', {
        type: 'ACCOUNT_DEACTIVATED',
        accountId
      });
      res.json({ success: true, accountId });
    }
  });
});

// PATCH bet-cycle toggle
automationRouter.patch('/accounts/:id/bet-cycle', async (req, res) => {
  const accountId = req.params.id;
  const { enabled } = req.body || {};

  return executeCommand({
    req,
    res,
    category: 'Persistence',
    type: 'TOGGLE_BET_CYCLE',
    target: accountId,
    payload: { accountId, enabled: Boolean(enabled) },
    onSuccess: async () => {
      await repositoryFactory.getConfigRepo().updateAccountConfig(accountId, { betCycleEnabled: Boolean(enabled) });
      wsServer.broadcast('automation:delta', {
        type: 'ACCOUNT_UPDATED',
        accountId,
        partialSnapshot: { betCycleEnabled: Boolean(enabled) }
      });
      res.json({ accountId, betCycleEnabled: Boolean(enabled) });
    }
  });
});

// PUT per-account config overrides
automationRouter.put('/accounts/:id/config', async (req, res) => {
  const accountId = req.params.id;
  const { category, source, values } = req.body || {};

  return executeCommand({
    req,
    res,
    category: 'Persistence',
    type: 'UPDATE_ACCOUNT_CONFIG',
    target: accountId,
    payload: { accountId, category, source, values },
    onSuccess: async () => {
      const updates = {};
      if (category === 'pricing') {
        updates.pricingSource = source;
        updates.customPricing = values;
      } else if (category === 'risk') {
        updates.riskSource = source;
        updates.customRisk = values;
      } else if (category === 'rebet') {
        updates.rebetSource = source;
        updates.customRebet = values;
      }
      await repositoryFactory.getConfigRepo().updateAccountConfig(accountId, updates);
      const snapshot = await workspaceAggregator.getSnapshot();
      const account = snapshot.accounts.find(a => a.id === accountId);
      wsServer.broadcast('automation:delta', {
        type: 'ACCOUNT_UPDATED',
        accountId,
        partialSnapshot: account || { id: accountId, ...updates }
      });
      res.json({ success: true, account });
    }
  });
});

// PUT global config category
automationRouter.put('/config/:category', async (req, res) => {
  const category = req.params.category;
  const { values } = req.body || {};

  return executeCommand({
    req,
    res,
    category: 'Persistence',
    type: 'UPDATE_GLOBAL_CONFIG',
    payload: { category, values },
    capability: CAPABILITY.CONFIG_MODIFY,
    onSuccess: async () => {
      const updatedGlobalConfig = await repositoryFactory.getConfigRepo().updateCategory(category, values);
      wsServer.broadcast('automation:delta', {
        type: 'GLOBAL_CONFIG_UPDATED',
        category,
        values
      });
      res.json({ success: true, globalConfig: updatedGlobalConfig });
    }
  });
});
