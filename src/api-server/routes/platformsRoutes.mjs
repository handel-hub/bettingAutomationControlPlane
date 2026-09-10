// @ts-check
import { Router } from 'express';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';

export const platformsRouter = Router();

// GET /api/v1/platforms
platformsRouter.get('/', (req, res) => {
  try {
    const store = getSharedStateStore();
    const registry = store.catalogs.getPlatformRegistry();
    res.setHeader('X-Protocol-Version', '2.0');
    res.setHeader('X-Revision', String(store.catalogs.revision));
    res.json(registry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
