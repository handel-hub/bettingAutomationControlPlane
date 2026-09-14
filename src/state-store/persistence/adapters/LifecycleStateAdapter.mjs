// @ts-check

/**
 * Valid lifecycle state definitions for Desired vs Observed states.
 */
export const DesiredLifecycleState = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING'
});

export const ObservedLifecycleState = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING_HANDSHAKE: 'STARTING_HANDSHAKE',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  ABORTED: 'ABORTED',
  ERROR_DEGRADED: 'ERROR_DEGRADED'
});

/**
 * Persistence adapter for system_lifecycle_state table.
 */
export class LifecycleStateAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Fetches the current system lifecycle state.
   * @returns {{ id: string, desiredState: string, observedState: string, generation: number, lastTransitionAt: string, transitionReason: string }}
   */
  get() {
    const row = this.engine.prepare(`
      SELECT id, desired_state AS desiredState, observed_state AS observedState,
             generation, last_transition_at AS lastTransitionAt,
             transition_reason AS transitionReason
      FROM system_lifecycle_state
      WHERE id = 'primary'
    `).get();

    if (!row) {
      return {
        id: 'primary',
        desiredState: DesiredLifecycleState.STOPPED,
        observedState: ObservedLifecycleState.STOPPED,
        generation: 1,
        lastTransitionAt: new Date().toISOString(),
        transitionReason: 'FALLBACK_DEFAULT'
      };
    }

    return row;
  }

  /**
   * Sets desired state (e.g. from user command).
   * @param {'STOPPED' | 'RUNNING'} desiredState
   * @param {string} reason
   */
  setDesiredState(desiredState, reason = 'USER_COMMAND') {
    const now = new Date().toISOString();
    this.engine.prepare(`
      INSERT INTO system_lifecycle_state (id, desired_state, observed_state, generation, last_transition_at, transition_reason)
      VALUES ('primary', ?, 'STOPPED', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        desired_state = excluded.desired_state,
        generation = system_lifecycle_state.generation + 1,
        last_transition_at = excluded.last_transition_at,
        transition_reason = excluded.transition_reason
    `).run(desiredState, now, reason);

    return this.get();
  }

  /**
   * Updates observed state (e.g. from Execution Plane event or handshake).
   * @param {'STOPPED' | 'STARTING_HANDSHAKE' | 'RUNNING' | 'STOPPING' | 'ABORTED' | 'ERROR_DEGRADED'} observedState
   * @param {string} reason
   */
  setObservedState(observedState, reason = 'EP_EVENT') {
    const now = new Date().toISOString();
    this.engine.prepare(`
      INSERT INTO system_lifecycle_state (id, desired_state, observed_state, generation, last_transition_at, transition_reason)
      VALUES ('primary', 'STOPPED', ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_state = excluded.observed_state,
        generation = system_lifecycle_state.generation + 1,
        last_transition_at = excluded.last_transition_at,
        transition_reason = excluded.transition_reason
    `).run(observedState, now, reason);

    return this.get();
  }

  /**
   * Force resets observed state to STOPPED on boot.
   * Satisfies KILL_ON_JOB_CLOSE guarantee: no child process can survive a CP restart.
   * @param {string} reason
   */
  resetObservedStateOnBoot(reason = 'RECOVERY_BOOT_RESET') {
    const now = new Date().toISOString();
    this.engine.prepare(`
      INSERT INTO system_lifecycle_state (id, desired_state, observed_state, generation, last_transition_at, transition_reason)
      VALUES ('primary', 'STOPPED', 'STOPPED', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_state = 'STOPPED',
        generation = system_lifecycle_state.generation + 1,
        last_transition_at = excluded.last_transition_at,
        transition_reason = excluded.transition_reason
    `).run(now, reason);

    return this.get();
  }
}
