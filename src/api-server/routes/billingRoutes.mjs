// @ts-check
import { Router } from 'express';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { wsServer } from '../websocket/wsServer.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { backendClient } from '../../security-authority/protocol/backend-client.mjs';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';

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

// POST initialize checkout -> authoritative Backend initiation
billingRouter.post('/checkout/initialize', async (req, res) => {
  try {
    const { planId, planName = 'Pro', billingInterval = 'monthly', returnUrl } = req.body || {};
    const targetPlanId = planId || planName;
    const checkoutData = await backendClient.initiateCheckout(targetPlanId, billingInterval, returnUrl);
    res.json(checkoutData);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST verify transaction -> authoritative Backend verification & state store hydration
billingRouter.post('/checkout/verify', async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) {
    return res.status(400).json({ error: 'Missing transaction reference' });
  }

  return executeCommand({
    req,
    res,
    category: 'Billing',
    type: 'VERIFY_CHECKOUT',
    payload: { reference },
    onSuccess: async () => {
      try {
        const verifyRes = await backendClient.verifyCheckout(reference);
        const store = getSharedStateStore();

        if (verifyRes?.snapshot) {
          const billingRepo = repositoryFactory.getBillingRepository();
          if (billingRepo && typeof billingRepo.hydrate === 'function') {
            billingRepo.hydrate(verifyRes.snapshot, verifyRes.snapshot.invoices || []);
          }
        }

        const snapshot = store.billing.getSnapshot();
        if (verifyRes && verifyRes.verified === false) {
          return res.status(400).json({
            reference,
            verified: false,
            error: verifyRes.error || 'Payment not verified on payment gateway',
            snapshot
          });
        }

        wsServer.broadcast('billing:snapshot', snapshot);
        wsServer.broadcast('app:state', { state: 'Authorized' });
        res.json({
          reference,
          verified: true,
          status: 'Authorized',
          snapshot
        });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message, verified: false });
      }
    }
  });
});

// POST portal session
billingRouter.post('/session', async (req, res) => {
  res.json({ portalUrl: 'https://flutterwave.com' });
});

// POST cancel subscription -> authoritative Backend cancel
billingRouter.post('/subscription/cancel', async (req, res) => {
  try {
    const cancelRes = await backendClient.cancelSubscription();
    const store = getSharedStateStore();
    const expirationDate = cancelRes?.expirationDate || new Date(Date.now() + 15 * 86400000).toISOString();
    store.billing.updateSubscription({ status: 'Cancelled', expirationDate });
    const snapshot = store.billing.getSnapshot();
    wsServer.broadcast('billing:snapshot', snapshot);
    res.json({ status: 'Cancelled', expirationDate });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST resume subscription -> authoritative Backend resume
billingRouter.post('/subscription/resume', async (req, res) => {
  try {
    const resumeRes = await backendClient.resumeSubscription();
    const store = getSharedStateStore();
    const renewalDate = resumeRes?.renewalDate || new Date(Date.now() + 30 * 86400000).toISOString();
    store.billing.updateSubscription({ status: 'Active', renewalDate });
    const snapshot = store.billing.getSnapshot();
    wsServer.broadcast('billing:snapshot', snapshot);
    res.json({ status: 'Active', renewalDate });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
