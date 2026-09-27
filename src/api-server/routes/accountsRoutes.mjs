// @ts-check
import { Router } from 'express';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { wsServer } from '../websocket/wsServer.mjs';
import { backendSyncService } from '../../sync/backendSyncService.mjs';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { sanitizeAccountForExport } from '../../state-store/validation/SanitizerGate.mjs';
import { RevisionConflictError } from '../../state-store/types/errors.mjs';

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
      const sanitized = sanitizeAccountForExport(created);
      wsServer.broadcast('accounts:delta', {
        type: 'ACCOUNT_CREATED',
        partialSnapshot: sanitized
      });
      backendSyncService.saveLocalCache();

      const automationSnapshot = await workspaceAggregator.getSnapshot();
      wsServer.broadcast('automation:snapshot', automationSnapshot);

      res.setHeader('X-Protocol-Version', '2.0');
      res.status(201).json(sanitized);
    }
  });
});

// GET single account details
accountsRouter.get('/:id', async (req, res) => {
  const account = await repositoryFactory.getAccountsRepo().findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const sanitized = sanitizeAccountForExport(account);
  res.json({ ...sanitized, history: [], diagnostics: { uptime: '100%', networkLatencyMs: 45 } });
});

// PATCH update account details / password
accountsRouter.patch('/:id', async (req, res) => {
  try {
    const accountId = req.params.id;
    const updates = req.body || {};
    const existing = await repositoryFactory.getAccountsRepo().findById(accountId);
    if (!existing) return res.status(404).json({ error: 'Account not found' });

    // OCC: Extract expectedRevision from If-Match, x-expected-revision header, or body
    const ifMatch = req.headers['if-match'];
    const headerRevision = req.headers['x-expected-revision'];
    const bodyRevision = req.body?.expectedRevision;
    let expectedRevision = null;
    if (headerRevision !== undefined && headerRevision !== null) {
      expectedRevision = Number(headerRevision);
    } else if (ifMatch) {
      const match = String(ifMatch).replace(/["'W/]/g, '').trim();
      if (match && !isNaN(Number(match))) expectedRevision = Number(match);
    } else if (bodyRevision !== undefined && bodyRevision !== null) {
      expectedRevision = Number(bodyRevision);
    }

    const updated = await repositoryFactory.getAccountsRepo().update(accountId, updates, expectedRevision);
    backendSyncService.saveLocalCache();
    const sanitized = sanitizeAccountForExport(updated);
    wsServer.broadcast('accounts:delta', {
      type: 'ACCOUNT_UPDATED',
      accountId,
      partialSnapshot: sanitized
    });
    res.json(sanitized);
  } catch (err) {
    if (err instanceof RevisionConflictError || err.name === 'RevisionConflictError' || err.code === 'ERR_REVISION_CONFLICT') {
      return res.status(409).json({
        error: 'Revision Conflict',
        message: err.message,
        expectedRevision: err.expectedRevision,
        actualRevision: err.actualRevision
      });
    }
    return res.status(500).json({ error: err.message });
  }
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
        workspaceAggregator.deactivateAccount(accountId);
        await repositoryFactory.getAccountsRepo().delete(accountId);
        wsServer.broadcast('accounts:delta', { 
          type: 'ACCOUNT_DELETED', 
          accountId,
          partialSnapshot: null
        });
      } else if (type === 'ACTIVATE_ACCOUNT') {
        await repositoryFactory.getAccountsRepo().update(accountId, { backendState: 'ACTIVE', presentationCategory: 'Healthy' });
        wsServer.broadcast('accounts:delta', { 
          type: 'ACCOUNT_STATUS_CHANGED', 
          accountId, 
          backendState: 'ACTIVE', 
          presentationCategory: 'Healthy',
          partialSnapshot: {
            backendState: 'ACTIVE',
            presentationCategory: 'Healthy',
            statusDescription: 'Account is healthy and ready for automation'
          }
        });
      } else if (type === 'DEACTIVATE_ACCOUNT') {
        workspaceAggregator.deactivateAccount(accountId);
        await repositoryFactory.getAccountsRepo().update(accountId, { backendState: 'SUSPENDED', presentationCategory: 'Neutral' });
        wsServer.broadcast('accounts:delta', { 
          type: 'ACCOUNT_STATUS_CHANGED', 
          accountId, 
          backendState: 'SUSPENDED', 
          presentationCategory: 'Neutral',
          partialSnapshot: {
            backendState: 'SUSPENDED',
            presentationCategory: 'Neutral',
            statusDescription: 'Account is suspended'
          }
        });
        wsServer.broadcast('automation:delta', {
          type: 'ACCOUNT_DEACTIVATED',
          accountId
        });
      }
      backendSyncService.saveLocalCache();
      const automationSnapshot = await workspaceAggregator.getSnapshot();
      wsServer.broadcast('automation:snapshot', automationSnapshot);
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
      
      // Broadcast atomic deltas per affected account
      if (Array.isArray(accountIds)) {
        if (type === 'BULK_DELETE') {
          for (const id of accountIds) {
            workspaceAggregator.deactivateAccount(id);
            wsServer.broadcast('accounts:delta', { type: 'ACCOUNT_DELETED', accountId: id });
            wsServer.broadcast('automation:delta', { type: 'ACCOUNT_DEACTIVATED', accountId: id });
          }
        } else if (type === 'BULK_ACTIVATE') {
          for (const id of accountIds) {
            const acc = await repositoryFactory.getAccountsRepo().findById(id);
            if (acc) {
              const sanitized = sanitizeAccountForExport({
                ...acc,
                backendState: 'ACTIVE',
                presentationCategory: 'Healthy'
              });
              wsServer.broadcast('accounts:delta', {
                type: 'ACCOUNT_STATUS_CHANGED',
                accountId: id,
                backendState: 'ACTIVE',
                presentationCategory: 'Healthy',
                partialSnapshot: sanitized
              });
            }
          }
        } else if (type === 'BULK_DEACTIVATE') {
          for (const id of accountIds) {
            workspaceAggregator.deactivateAccount(id);
            const acc = await repositoryFactory.getAccountsRepo().findById(id);
            if (acc) {
              const sanitized = sanitizeAccountForExport({
                ...acc,
                backendState: 'SUSPENDED',
                presentationCategory: 'Neutral'
              });
              wsServer.broadcast('accounts:delta', {
                type: 'ACCOUNT_STATUS_CHANGED',
                accountId: id,
                backendState: 'SUSPENDED',
                presentationCategory: 'Neutral',
                partialSnapshot: sanitized
              });
              wsServer.broadcast('automation:delta', {
                type: 'ACCOUNT_DEACTIVATED',
                accountId: id
              });
            }
          }
        }
      }

      wsServer.broadcast('accounts:delta', { type: 'BULK_OPERATION_RESULT', result });
      backendSyncService.saveLocalCache();
      const automationSnapshot = await workspaceAggregator.getSnapshot();
      wsServer.broadcast('automation:snapshot', automationSnapshot);
      res.json(result);
    }
  });
});
