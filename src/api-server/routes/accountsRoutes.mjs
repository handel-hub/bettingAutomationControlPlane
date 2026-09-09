// @ts-check
import { Router } from 'express';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { wsServer } from '../websocket/wsServer.mjs';

export const accountsRouter = Router();

// GET accounts list
accountsRouter.get('/', async (req, res) => {
  try {
    const { offset = 0, limit = 50, filterQuery = '' } = req.query;
    const result = await repositoryFactory.getAccountsRepo().list(
      { filterQuery: String(filterQuery) },
      { offset: Number(offset), limit: Number(limit) }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST register new account
accountsRouter.post('/', async (req, res) => {
  const { name, platformDisplayName, accountUsername, accountPassword, tags } = req.body || {};
  if (!platformDisplayName || !accountUsername) {
    return res.status(400).json({ error: 'platformDisplayName and accountUsername are required' });
  }

  return executeCommand({
    req,
    res,
    category: 'Persistence',
    type: 'REGISTER_ACCOUNT',
    payload: { name, platformDisplayName, accountUsername, accountPassword, tags },
    onSuccess: async (commandResult) => {
      const created = commandResult?.id ? commandResult : await repositoryFactory.getAccountsRepo().create({
        name: name || accountUsername,
        platformDisplayName,
        accountUsername,
        accountPassword,
        tags
      });
      wsServer.broadcast('accounts:delta', {
        type: 'ACCOUNT_CREATED',
        partialSnapshot: created
      });
      res.status(201).json(created);
    }
  });
});

// GET single account details
accountsRouter.get('/:id', async (req, res) => {
  const account = await repositoryFactory.getAccountsRepo().findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json({ ...account, history: [], diagnostics: { uptime: '100%', networkLatencyMs: 45 } });
});

// POST single account action
accountsRouter.post('/:id/action', async (req, res) => {
  const { type } = req.body || {};
  const accountId = req.params.id;

  return executeCommand({
    req,
    res,
    category: 'Persistence',
    type: 'ACCOUNT_ACTION',
    target: accountId,
    payload: { actionType: type },
    onSuccess: async () => {
      if (type === 'DELETE_ACCOUNT') {
        await repositoryFactory.getAccountsRepo().delete(accountId);
        wsServer.broadcast('accounts:delta', { type: 'ACCOUNT_DELETED', accountId });
      } else if (type === 'ACTIVATE_ACCOUNT') {
        await repositoryFactory.getAccountsRepo().update(accountId, { backendState: 'ACTIVE', presentationCategory: 'Healthy' });
        wsServer.broadcast('accounts:delta', { type: 'ACCOUNT_STATUS_CHANGED', accountId, backendState: 'ACTIVE', presentationCategory: 'Healthy' });
      } else if (type === 'DEACTIVATE_ACCOUNT') {
        await repositoryFactory.getAccountsRepo().update(accountId, { backendState: 'SUSPENDED', presentationCategory: 'Neutral' });
        wsServer.broadcast('accounts:delta', { type: 'ACCOUNT_STATUS_CHANGED', accountId, backendState: 'SUSPENDED', presentationCategory: 'Neutral' });
      }
      res.json({ success: true, accountId });
    }
  });
});

// POST bulk action
accountsRouter.post('/bulk-action', async (req, res) => {
  const { type, accountIds } = req.body || {};
  return executeCommand({
    req,
    res,
    category: 'Persistence',
    type: 'BULK_ACTION',
    payload: { type, accountIds },
    onSuccess: async () => {
      const result = await repositoryFactory.getAccountsRepo().bulkAction(type, accountIds);
      wsServer.broadcast('accounts:delta', { type: 'BULK_OPERATION_RESULT', result });
      res.json(result);
    }
  });
});
