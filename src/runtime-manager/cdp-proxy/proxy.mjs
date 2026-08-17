// @ts-check

import { cdpFraming } from './framing.mjs';

/**
 * Validating proxy for CDP traffic. Prevents the runtime from 
 * executing prohibited browser-level commands.
 */
export class CdpProxy {
  /**
   * Inspects and routes an outbound CDP command.
   * @param {string} commandJson 
   * @returns {boolean} true if command is allowed
   */
  allowCommand(commandJson) {
    try {
      const command = JSON.parse(commandJson);
      return this._isCommandAllowed(command);
    } catch {
      return false;
    }
  }

  /**
   * @param {any} command 
   * @returns {boolean}
   */
  _isCommandAllowed(command) {
    if (!command || typeof command !== 'object') return true;

    if (command.method) {
      // Recursively unwrap Target.sendMessageToTarget
      if (command.method === 'Target.sendMessageToTarget') {
        if (command.params && typeof command.params.message === 'string') {
          try {
            const innerCommand = JSON.parse(command.params.message);
            if (!this._isCommandAllowed(innerCommand)) {
              return false;
            }
          } catch {
            return false;
          }
        }
      } else {
        // Drop the message if any inner or outer method starts with Target. or Browser.
        if (command.method.startsWith('Target.') || command.method.startsWith('Browser.')) {
          console.warn(`[CdpProxy] BLOCKED forbidden CDP command: ${command.method}`);
          return false;
        }
      }

      // Keep existing blacklisted commands just in case
      if (command.method.startsWith('Security.setIgnoreCertificateErrors')) {
        console.warn(`[CdpProxy] BLOCKED forbidden CDP command: ${command.method}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Formats a command for IPC transit.
   * @param {string} commandJson 
   * @returns {string}
   */
  pack(commandJson) {
    return cdpFraming.frame(commandJson);
  }
}

export const cdpProxy = new CdpProxy();
