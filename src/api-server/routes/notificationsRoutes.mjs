// @ts-check
import { Router } from 'express';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { wsServer } from '../websocket/wsServer.mjs';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const { unreadOnly, severity } = req.query;
  const result = await repositoryFactory.getNotificationsRepo().list({
    unreadOnly: unreadOnly === 'true',
    severity: String(severity || 'ALL')
  });
  res.setHeader('X-Protocol-Version', '2.0');
  res.json(result);
});

const handleMarkRead = async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().markRead(req.params.id);
  wsServer.broadcast('notifications:delta', {
    type: 'NOTIFICATION_READ',
    id: req.params.id
  });
  res.json(result);
};

notificationsRouter.patch('/:id/read', handleMarkRead);
notificationsRouter.post('/:id/read', handleMarkRead);

const handleMarkAllRead = async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().markAllRead();
  wsServer.broadcast('notifications:delta', {
    type: 'ALL_READ',
    result
  });
  res.json(result);
};

notificationsRouter.post('/mark-all-read', handleMarkAllRead);
notificationsRouter.post('/read-all', handleMarkAllRead);

notificationsRouter.delete('/:id', async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().delete(req.params.id);
  wsServer.broadcast('notifications:delta', {
    type: 'NOTIFICATION_DELETED',
    id: req.params.id
  });
  res.json(result);
});

notificationsRouter.delete('/clear-all', async (req, res) => {
  const result = await repositoryFactory.getNotificationsRepo().clearAll();
  wsServer.broadcast('notifications:delta', {
    type: 'NOTIFICATIONS_CLEARED'
  });
  res.json(result);
});
