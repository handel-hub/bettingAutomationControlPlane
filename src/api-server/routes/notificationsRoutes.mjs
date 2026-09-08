// @ts-check
import { Router } from 'express';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const { unreadOnly, severity } = req.query;
  const result = await repositoryFactory.getNotificationsRepo().list({
    unreadOnly: unreadOnly === 'true',
    severity: String(severity || 'ALL')
  });
  res.json(result);
});

notificationsRouter.patch('/:id/read', async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().markRead(req.params.id);
  res.json(result);
});

notificationsRouter.post('/mark-all-read', async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().markAllRead();
  res.json(result);
});

notificationsRouter.delete('/:id', async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().delete(req.params.id);
  res.json(result);
});

notificationsRouter.delete('/clear-all', async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().clearAll();
  res.json(result);
});
