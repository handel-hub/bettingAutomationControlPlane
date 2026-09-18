// @ts-check
import { Router } from 'express';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { operationTracker } from '../../state/operationTracker.mjs';

export const preludeRouter = Router();

// GET /api/v1/prelude
preludeRouter.get('/', async (req, res) => {
  try {
    const store = getSharedStateStore();
    const workspaceSnapshot = await workspaceAggregator.getSnapshot();
    const runtimeState = {
      lifecycleState: 'Authorized',
      lifecycle: workspaceAggregator.lifecycle,
      automationLifecycle: workspaceAggregator.lifecycle,
      lifecycleMessage: workspaceAggregator.lifecycleMessage,
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
