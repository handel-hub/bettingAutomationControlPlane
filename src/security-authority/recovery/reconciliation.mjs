// @ts-check

/**
 * Reconciles the local Control Plane state with the Server Trust state.
 */
export class ReconciliationManager {
  /**
   * Evaluates if the machine's local generation string matches the server's truth.
   * @param {number} localGeneration 
   * @param {number} serverGeneration 
   * @returns {boolean}
   */
  isMachineSynchronized(localGeneration, serverGeneration) {
    return localGeneration === serverGeneration;
  }
}

export const reconciliationManager = new ReconciliationManager();
