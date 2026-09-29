// @ts-check
import { Router } from 'express';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { operationTracker } from '../../state/operationTracker.mjs';
import { securityFacade } from '../../security-authority/facade.mjs';

export const preludeRouter = Router();

// GET /api/v1/prelude
preludeRouter.get('/', async (req, res) => {
  try {
    const store = getSharedStateStore();
    const workspaceSnapshot = await workspaceAggregator.getSnapshot();
    const billingSnapshot = store.billing.getSnapshot();
    const isPaymentRequired = billingSnapshot?.status === 'Payment_Required' || billingSnapshot?.status === 'Past_Due';
    const secState = securityFacade.getSystemState();

    let computedLifecycleState = 'Authorized';
    if (isPaymentRequired) {
      computedLifecycleState = 'Payment_Required';
    } else if (securityFacade.isDegraded()) {
      computedLifecycleState = 'Degraded';
    } else if (secState === 'OFFLINE_GRACE') {
      computedLifecycleState = 'Offline_Grace';
    } else if (secState === 'UNINITIALIZED' || secState === 'INITIALIZING' || secState === 'SECURITY_STATE_READY' || secState === 'UNAUTHENTICATED' || secState === 'AUTHENTICATING') {
      computedLifecycleState = 'Awaiting_Auth';
    } else if (secState === 'REVOKED' || secState === 'COMPROMISED') {
      computedLifecycleState = 'Revoked';
    }

    const runtimeState = {
      lifecycleState: computedLifecycleState,
      lifecycle: workspaceAggregator.lifecycle,
      automationLifecycle: workspaceAggregator.lifecycle,
      lifecycleMessage: isPaymentRequired ? 'Payment required to activate automation suite' : workspaceAggregator.lifecycleMessage,
      automationMessage: workspaceAggregator.lifecycleMessage,
      capabilities: workspaceSnapshot.capabilities,
      automationCapabilities: workspaceSnapshot.capabilities,
      automationAccounts: workspaceSnapshot.accounts,
      stagedAccountIds: workspaceAggregator.stagedAccountIds,
      systemStatus: workspaceSnapshot.systemStatus,
      globalActionPending: operationTracker.getCurrentPendingAction()
    };

    const rawPrelude = store.getPreludeSnapshot(runtimeState);
    const prelude = rawPrelude.payload || rawPrelude;
    res.setHeader('X-Protocol-Version', '2.0');
    res.json(prelude);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
