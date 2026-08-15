// @ts-check

import { CAPABILITY } from './capabilities.mjs';

/**
 * Validates and manages user authorization based on cryptographic capabilities.
 */
export class AuthorizationManager {
  /**
   * Resolves the capability set for a given license and identity level.
   * In a real implementation, this checks the cryptographically signed entitlement.
   * 
   * @param {Object} identity 
   * @param {string} identity.userId
   * @param {Object} license
   * @param {string} license.tier
   * @returns {import('./capabilities.mjs').Capability[]}
   */
  resolveCapabilities(identity, license) {
    /** @type {import('./capabilities.mjs').Capability[]} */
    const baseCapabilities = [CAPABILITY.MARKET_DATA_STREAM];

    if (license.tier === 'ENTERPRISE') {
      baseCapabilities.push(
        CAPABILITY.AUTOMATION_START,
        CAPABILITY.STRATEGY_EDIT,
        CAPABILITY.DATA_EXPORT
      );
    } else if (license.tier === 'PRO') {
      baseCapabilities.push(
        CAPABILITY.AUTOMATION_START,
        CAPABILITY.STRATEGY_EDIT
      );
    }

    return baseCapabilities;
  }

  /**
   * Evaluates if a capability request is authorized against the active set.
   * 
   * @param {import('./capabilities.mjs').Capability[]} currentCapabilities 
   * @param {import('./capabilities.mjs').Capability} requiredCapability 
   * @returns {boolean}
   */
  isAuthorized(currentCapabilities, requiredCapability) {
    return currentCapabilities.includes(requiredCapability);
  }
}

export const authorizationManager = new AuthorizationManager();
