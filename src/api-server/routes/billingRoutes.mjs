// @ts-check
import { Router } from 'express';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { wsServer } from '../websocket/wsServer.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';

export const billingRouter = Router();

// GET billing snapshot
billingRouter.get('/', async (req, res) => {
  const store = getSharedStateStore();
  const snapshot = store.billing.getSnapshot();
  res.setHeader('X-Protocol-Version', '2.0');
  res.json(snapshot);
});

// GET subscription plans catalog
billingRouter.get('/plans', (req, res) => {
  try {
    const store = getSharedStateStore();
    const catalog = store.catalogs.getPlansCatalog();
    res.setHeader('X-Protocol-Version', '2.0');
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST initialize checkout
billingRouter.post('/checkout/initialize', async (req, res) => {
  const { planName = 'Pro', email = 'operator@bettingautomation.io' } = req.body || {};
  const reference = `PSTK-REC-${Date.now()}`;
  res.json({
    authorizationUrl: `https://checkout.paystack.com/${reference}`,
    accessCode: `acc_${reference}`,
    reference
  });
});

// POST verify transaction
billingRouter.post('/checkout/verify', async (req, res) => {
  const { reference } = req.body || {};
  return executeCommand({
    req,
    res,
    category: 'Billing',
    type: 'VERIFY_CHECKOUT',
    payload: { reference },
    onSuccess: async () => {
      const store = getSharedStateStore();
      const verified = {
        reference,
        verified: true,
        snapshot: store.billing.getSnapshot()
      };
      wsServer.broadcast('billing:snapshot', verified.snapshot);
      res.json(verified);
    }
  });
});

// POST portal session
billingRouter.post('/session', async (req, res) => {
  res.json({ portalUrl: 'https://billing.paystack.com/session/sample' });
});

// POST cancel subscription
billingRouter.post('/subscription/cancel', async (req, res) => {
  const store = getSharedStateStore();
  const expirationDate = new Date(Date.now() + 15 * 86400000).toISOString();
  store.billing.updateSubscription({ status: 'Cancelled', expirationDate });
  res.json({ status: 'Cancelled', expirationDate });
});

// POST resume subscription
billingRouter.post('/subscription/resume', async (req, res) => {
  const store = getSharedStateStore();
  const renewalDate = new Date(Date.now() + 30 * 86400000).toISOString();
  store.billing.updateSubscription({ status: 'Active', renewalDate });
  res.json({ status: 'Active', renewalDate });
});
