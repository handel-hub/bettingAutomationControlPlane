// @ts-check
import { Router } from 'express';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { operationTracker } from '../../state/operationTracker.mjs';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { CAPABILITY } from '../../security-authority/authorization/capabilities.mjs';
import { wsServer } from '../websocket/wsServer.mjs';

export const automationRouter = Router();

// GET full workspace snapshot
automationRouter.get('/snapshot', async (req, res) => {
  try {
    const snapshot = await workspaceAggregator.getSnapshot();
    res.json(snapshot);
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
    onSuccess: () => {
      workspaceAggregator.setLifecycle('RUNNING');
      wsServer.broadcast('automation:delta', {
        type: 'LIFECYCLE_CHANGED',
        lifecycle: 'RUNNING'
      });
      res.json({ success: true, lifecycle: 'STARTING' });
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
    onSuccess: () => {
      workspaceAggregator.setLifecycle('STOPPED');
      wsServer.broadcast('automation:delta', {
        type: 'LIFECYCLE_CHANGED',
        lifecycle: 'STOPPED'
      });
      res.json({ success: true, lifecycle: 'STOPPING' });
    }
  });
});

// POST tactical place-bet
automationRouter.post('/operations/place-bet', async (req, res) => {
  const { marketId, odds, stake } = req.body || {};
  const op = operationTracker.startOperation('PLACING_BET', { marketId, odds, stake });

  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: 'PLACING_BET' }
  });

  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'PLACE_BET',
    payload: { marketId, odds, stake, operationId: op.operationId },
    onSuccess: () => {
      // Return 202 Accepted / QUEUED status per contract
      res.status(202).json({ operationId: op.operationId, status: 'QUEUED' });
    }
  });
});

// POST tactical cash-out
automationRouter.post('/operations/cash-out', async (req, res) => {
  const { betId, threshold } = req.body || {};
  const op = operationTracker.startOperation('CASHING_OUT', { betId, threshold });

  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: 'CASHING_OUT' }
  });

  return executeCommand({
    req,
    res,
    category: 'Execution',
    type: 'CASH_OUT',
    payload: { betId, threshold, operationId: op.operationId },
    onSuccess: () => {
      res.status(202).json({ operationId: op.operationId, status: 'QUEUED' });
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
      res.json({ success: true, globalConfig: updatedGlobalConfig });
    }
  });
});
