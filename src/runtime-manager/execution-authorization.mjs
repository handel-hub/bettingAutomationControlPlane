// @ts-check

import { securityFacade } from '../security-authority/facade.mjs';
import { CAPABILITY } from '../security-authority/authorization/capabilities.mjs';

/**
 * Validates whether the Runtime Manager is authorized to spawn
 * or interact with automated instances.
 */
export class ExecutionAuthorization {
  /**
   * Checks if starting automation is permitted by the current security state.
   * @returns {boolean}
   */
  canStartAutomation() {
    const result = securityFacade.authorize(CAPABILITY.AUTOMATION_START);
    return result.status === 'OPERATIONAL';
  }
}

export const executionAuthorization = new ExecutionAuthorization();
