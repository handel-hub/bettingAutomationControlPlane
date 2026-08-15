// @ts-check

import { engineInstance } from '../decision-engine.mjs';
import { SecurityState } from '../state-machine/states.mjs';

/**
 * Handles repairing the Security Authority on dirty startup.
 */
export class CrashRecovery {
  /**
   * Inspects the last recorded transition and attempts to repair state.
   */
  async runRecoveryChecks() {
    const state = engineInstance.inMemoryState;
    if (!state) return;

    if (state.state === SecurityState.FAULT) {
      console.error("[CrashRecovery] Booted into FAULT state. Manual intervention required.");
    }
  }
}

export const crashRecovery = new CrashRecovery();
