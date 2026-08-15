// @ts-check

import { envelopeCodec } from './envelope.mjs';

/**
 * Handles communication with the central Server Trust Backend.
 * Wraps outgoing messages in signed envelopes.
 */
export class BackendClient {
  constructor() {
    this.endpoint = "https://api.betting-automation.local/v1/control-plane";
  }

  /**
   * Sends a secure payload to the backend.
   * @param {string} path 
   * @param {any} data 
   * @returns {Promise<any>}
   */
  async securePost(path, data) {
    const envelope = envelopeCodec.createEnvelope(data);
    
    // In reality this uses fetch()
    console.log(`[BackendClient] POST ${this.endpoint}${path}`);
    console.log(`[BackendClient] Payload length: ${envelope.payload.length}, Sig: ${envelope.signature.slice(0, 16)}...`);

    // Mock successful response
    return {
      success: true,
      server_timestamp: Date.now()
    };
  }
}

export const backendClient = new BackendClient();
