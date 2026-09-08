// @ts-check
import { Router } from 'express';
import crypto from 'node:crypto';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { executeCommand } from '../middleware/commandAdapter.mjs';
import { wsServer } from '../websocket/wsServer.mjs';

export const billingRouter = Router();

// GET billing snapshot
billingRouter.get('/', async (req, res) => {
  const snapshot = await repositoryFactory.getBillingRepo().getSnapshot();
  res.json(snapshot);
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
      const verified = await repositoryFactory.getBillingRepo().verifyReference(reference);
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
  const expirationDate = new Date(Date.now() + 15 * 86400000).toISOString();
  await repositoryFactory.getBillingRepo().updateSubscription({ status: 'Cancelled', expirationDate });
  res.json({ status: 'Cancelled', expirationDate });
});

// POST resume subscription
billingRouter.post('/subscription/resume', async (req, res) => {
  const renewalDate = new Date(Date.now() + 30 * 86400000).toISOString();
  await repositoryFactory.getBillingRepo().updateSubscription({ status: 'Active', renewalDate });
  res.json({ status: 'Active', renewalDate });
});

// POST Paystack webhook with HMAC verification
billingRouter.post('/webhook/paystack', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (secret && req.rawBody) {
    const hash = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  const event = req.body || {};
  if (event.event === 'charge.success') {
    const amount = event.data?.amount ? event.data.amount / 100 : 10000;
    await repositoryFactory.getBillingRepo().addInvoice({
      id: `inv_${Date.now()}`,
      reference: event.data?.reference || `ref_${Date.now()}`,
      date: new Date().toISOString(),
      amount,
      status: 'Paid',
      receiptUrl: event.data?.receipt_url || null
    });
    const snapshot = await repositoryFactory.getBillingRepo().getSnapshot();
    wsServer.broadcast('billing:snapshot', snapshot);
  }

  res.json({ received: true });
});
