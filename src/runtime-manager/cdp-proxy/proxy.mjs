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
      
      // Blacklist destructive or high-privilege CDP commands
      const forbiddenPrefixes = [
        "Browser.close",
        "Browser.setDownloadBehavior",
        "Security.setIgnoreCertificateErrors"
      ];

      if (command.method && forbiddenPrefixes.some(p => command.method.startsWith(p))) {
        console.warn(`[CdpProxy] BLOCKED forbidden CDP command: ${command.method}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
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
