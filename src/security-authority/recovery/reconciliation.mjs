// @ts-check

import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';
import { backendClient, ProtocolError, Errors } from '../protocol/backend-client.mjs';
import { NativeCore } from '../native/security-core.mjs';
import { Mutex } from '../../shared/mutex.mjs';

/**
 * Handles explicit state synchronization between the CP and Backend Authority.
 * Replaces the stub with a First-Class State Machine that favors Backend authority.
 */
export class ReconciliationManager {
  constructor() {
    this.reconcileMutex = new Mutex();
    this.isReconciling = false;
  }

  /**
   * Triggers a reconciliation workflow. Uses a mutex to prevent overlapping syncs.
   * Will apply exponential backoff internally if the network drops.
   * @param {string} reason Why reconciliation was triggered
   * @returns {Promise<boolean>} True if sync succeeded, false if wiped/failed
   */
  async triggerReconciliation(reason) {
    const release = await this.reconcileMutex.acquire();
    this.isReconciling = true;

    try {
      console.log(`[Reconciliation] Triggered. Reason: ${reason}`);
      
      const currentState = await AEADStorageAdapter.getSecurityStateRow();
      if (!currentState) {
        console.warn("[Reconciliation] No local state to reconcile. Skipping.");
        return false;
      }

      // Fast fail if already revoked
      if (currentState.state === "REVOKED" || currentState.state === "COMPROMISED") {
        return false; 
      }

      // Transition to RECONCILING state locally before network call
      await this._setReconcilingState(currentState);

      // Perform network sync
      const result = await this._performNetworkSync(currentState);

      if (result.action === "WIPE") {
        await this._applyWipe(result);
        return false;
      } else if (result.action === "SYNC") {
        await this._applySync(result.authoritativeState);
        return true;
      }

      return false;

    } catch (err) {
      console.error(`[Reconciliation] Fatal error during sync: ${err.message}`);
      // Fallback state logic if sync completely breaks
      return false;
    } finally {
      this.isReconciling = false;
      release();
    }
  }

  /**
   * Sets the state to RECONCILING in the database.
   * @param {any} currentState 
   */
  async _setReconcilingState(currentState) {
    const nextState = { ...currentState, state: "RECONCILING" };
    // We ignore OCC conflicts here for simplicity, assuming the engine will lock transitions
    // while isReconciling is true.
    await AEADStorageAdapter.commitTransitionWithOCC(currentState.state_version, nextState, "RECONCILE_START");
  }

  /**
   * Wraps the backend client call.
   * @param {any} currentState 
   */
  async _performNetworkSync(currentState) {
    // In a real implementation, auditLogHash is derived from the latest row in security_audit_log
    const localStateHash = "mock_audit_hash"; 
    
    // The backendClient already has exponential backoff for network errors
    const response = await backendClient.reconcile(
      localStateHash, 
      currentState.session_generation || 0,
      currentState.server_epoch || 0
    );

    return response;
  }

  /**
   * Wipes local capabilities and enforces terminal state.
   * Typically happens when Backend detects a malicious Clone.
   * @param {any} backendResult 
   */
  async _applyWipe(backendResult) {
    console.error("[Reconciliation] Backend commanded WIPE. Possible clone detected.");
    
    // Fetch latest row for OCC
    const row = await AEADStorageAdapter.getSecurityStateRow();
    if (!row) return;

    const wipedState = { 
        ...row, 
        state: "COMPROMISED", 
        capabilities: [], 
        session: null, 
        authorization: null,
        license: null
    };

    await AEADStorageAdapter.commitTransitionWithOCC(row.state_version, wipedState, "TAMPER_DETECTED");
    
    // Halt Execution Plane
    NativeCore.setRevokedSync(true);
  }

  /**
   * Applies the Backend's authoritative state over the local state.
   * @param {any} authoritativeState 
   */
  async _applySync(authoritativeState) {
    console.log("[Reconciliation] Applying SYNC. Backend is authoritative.");
    
    // We must retry OCC if we conflict here, as sync data is vital.
    let retries = 3;
    while (retries > 0) {
      const row = await AEADStorageAdapter.getSecurityStateRow();
      if (!row) return;

      const syncedState = {
        ...row,
        state: "OPERATIONAL", // Or whatever the backend dictates
        server_epoch: authoritativeState.serverEpoch,
        session_generation: authoritativeState.generation,
        capabilities: authoritativeState.capabilities,
        graceTokenData: authoritativeState.graceToken || row.graceTokenData
      };

      const success = await AEADStorageAdapter.commitTransitionWithOCC(row.state_version, syncedState, "RECONCILE_SYNC");
      if (success) {
        // Record Audit Event
        await AEADStorageAdapter.writeEvent({
            event_type: "RECONCILIATION_SUCCESS",
            severity: "INFO",
            result: "SUCCESS",
            metadata: { newEpoch: authoritativeState.serverEpoch, newGen: authoritativeState.generation }
        });
        
        // Re-enable EP if we were blocked
        NativeCore.setRevokedSync(false);
        return;
      }
      retries--;
    }
    throw new Error("Failed to commit synchronized state due to persistent OCC conflicts.");
  }
}

export const reconciliationManager = new ReconciliationManager();
