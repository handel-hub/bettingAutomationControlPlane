// @ts-check

import { executeTransition } from './state-machine/engine.mjs';
import { StorageAdapter } from './persistence/storage-adapter.mjs';
import { TransitionEvent } from './state-machine/transitions.mjs';
import { SecurityState } from './state-machine/states.mjs';
import { NativeCore } from './native/security-core.mjs';

/**
 * The Decision Engine is the central brain of the Security Authority.
 * It coordinates the state machine transitions, evaluating Identity, Session, 
 * Authorization, License, Integrity, and Time inputs collectively.
 */
export class DecisionEngine {
  constructor() {
    /** @type {import('./state-machine/states.mjs').SecurityStateData | null} */
    this.inMemoryState = null;
  }

  /**
   * Initializes the Decision Engine and synchronizes state from persistence.
   */
  async initialize() {
    let rawState = await StorageAdapter.getSecurityStateRow();
    if (!rawState) {
      // Establish baseline UNINITIALIZED row for cold-boot on fresh database
      await StorageAdapter.commitTransitionWithOCC(0, {
        state: SecurityState.UNINITIALIZED,
        state_version: 0
      }, 'SYSTEM_BOOT');
      rawState = await StorageAdapter.getSecurityStateRow();
    }
    if (!rawState) {
      throw new Error("Cannot initialize DecisionEngine: Failed to establish security state in persistence.");
    }
    
    // In memory projection
    this.inMemoryState = {
      state: /** @type {import('./state-machine/states.mjs').SecurityStateEnum} */ (rawState.state),
      state_version: rawState.state_version,
      session: rawState.session,
      authorization: rawState.authorization,
      license: rawState.license,
      machine: rawState.machine
    };

    if (this.inMemoryState.state === SecurityState.UNINITIALIZED) {
      // Begin bootstrap automatically
      await this.dispatch(TransitionEvent.INITIALIZE, { singleInstanceLockHeld: true });
      // Verify hardware-backed identity through native OS boundary
      const isMachineValid = NativeCore.verifyMachineIdentitySync();
      
      await this.dispatch(TransitionEvent.BOOTSTRAP_COMPLETE, { 
        integrityVerified: true, 
        storageVerified: true, 
        machineIdentityVerified: isMachineValid 
      });
    }
  }

  /**
   * Dispatches an event to the state machine atomically.
   * @param {import('./state-machine/transitions.mjs').TransitionEventEnum} event 
   * @param {any} payload 
   * @returns {Promise<boolean>} True if the transition was successful
   */
  async dispatch(event, payload) {
    if (!this.inMemoryState) {
      throw new Error("DecisionEngine not initialized");
    }

    // Pass dependency functions to evaluate invariants dynamically
    const getCapabilities = (stateData) => stateData?.authorization?.capability_set ?? [];
    const hasActiveExecution = () => false; // to be hooked up to RuntimeManager

    const result = await executeTransition(
      this.inMemoryState,
      event,
      payload,
      getCapabilities,
      hasActiveExecution
    );

    if (result.success) {
      // Update in-memory projection
      this.inMemoryState = result.nextState;
      // Emit event bus notification
      return true;
    }
    return false;
  }

  /**
   * Returns the current validated capability set.
   * @returns {import('./authorization/capabilities.mjs').Capability[]}
   */
  getCurrentCapabilities() {
    if (this.inMemoryState?.state !== SecurityState.OPERATIONAL) {
      return [];
    }
    if (this.inMemoryState.authorization?.status !== 'VALID') {
      return [];
    }
    return this.inMemoryState.authorization.capability_set;
  }
}

export const engineInstance = new DecisionEngine();
