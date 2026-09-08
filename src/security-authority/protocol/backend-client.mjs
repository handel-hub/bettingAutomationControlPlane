// @ts-check

import { envelopeValidator } from './envelope.mjs';
import * as crypto from 'crypto';

/**
 * Custom Error Definitions for Protocol
 */
export class ProtocolError extends Error {
  /**
   * @param {string} code 
   * @param {string} message 
   */
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export const Errors = {
  ErrNetwork: 'ErrNetwork',
  ErrInvalidCredentials: 'ErrInvalidCredentials',
  ErrMachineBanned: 'ErrMachineBanned',
  ErrDuplicateInstallation: 'ErrDuplicateInstallation',
  ErrInvalidSignature: 'ErrInvalidSignature',
  ErrSessionExpired: 'ErrSessionExpired',
  ErrGenerationMismatch: 'ErrGenerationMismatch', // Triggers Reconciliation
  ErrEpochMismatch: 'ErrEpochMismatch', // Triggers Reconciliation
  ErrRevoked: 'ErrRevoked',
  ErrSuspended: 'ErrSuspended',
  ErrUnknownEpoch: 'ErrUnknownEpoch'
};

/**
 * Handles resilient communication with the Central Server Backend.
 * Manages Envelope V2 semantics, exponential backoff, and strict error typings.
 */
export class BackendClient {
  /**
   * @param {string} [endpoint]
   */
  constructor(endpoint) {
    this.endpoint = endpoint || process.env.BACKEND_API_URL || "https://api.betting-automation.local/v1/control-plane";
  }

  /**
   * Internal HTTP POST wrapper with exponential backoff for network-level failures.
   * Does NOT retry semantic/protocol errors.
   * @param {string} path 
   * @param {Object} data 
   * @param {number} maxRetries 
   * @returns {Promise<any>}
   */
  async _postWithRetry(path, data, maxRetries = 3) {
    const url = `${this.endpoint}${path}`;
    const requestEnvelope = envelopeValidator.createRequest(data);
    
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestEnvelope)
        });

        if (response.status >= 500 && response.status < 600) {
           throw new ProtocolError(Errors.ErrNetwork, `Server Error: ${response.status}`);
        }

        const json = await response.json();

        // 1. If backend returns an explicit protocol error, throw it without retrying
        if (json.error) {
           throw new ProtocolError(json.error.code || 'UNKNOWN_ERROR', json.error.message || 'Backend rejected request');
        }

        // 2. Cryptographic Validation Pipeline (Envelope V2)
        if (!envelopeValidator.validateEnvelope(json)) {
           throw new ProtocolError(Errors.ErrInvalidSignature, "Backend response failed cryptographic signature or freshness checks.");
        }

        // 3. Extract and return decoded payload
        const payloadBuffer = Buffer.from(json.payload, 'base64');
        const decodedPayload = JSON.parse(payloadBuffer.toString('utf8'));
        
        // Return full envelope context along with decoded payload for generation checks
        return { envelope: json, data: decodedPayload };

      } catch (err) {
        // If it's a semantic protocol error, bubble it up immediately
        if (err instanceof ProtocolError && err.code !== Errors.ErrNetwork) {
          throw err;
        }

        attempt++;
        if (attempt > maxRetries) {
          throw new ProtocolError(Errors.ErrNetwork, `Network/Fetch failure after ${maxRetries} retries: ${err.message}`);
        }

        // Exponential backoff: 500ms, 1000ms, 2000ms...
        const delay = Math.pow(2, attempt - 1) * 500;
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }

  /**
   * Authenticates the CP against the Backend.
   * @param {Object} credentials 
   * @param {Object} machineDescriptor 
   */
  async authenticate(credentials, machineDescriptor) {
    const { data, envelope } = await this._postWithRetry('/auth/login', {
      credentials,
      machineDescriptor
    });
    return {
      sessionId: data.sessionId,
      serverEpoch: envelope.server_epoch,
      generation: envelope.generation,
      capabilities: data.capabilities,
      graceToken: data.graceToken,
      signatures: envelope.signatures
    };
  }

  /**
   * Registers a new Machine Identity.
   * @param {Buffer} publicKey 
   * @param {string} installationId 
   * @param {Buffer} selfSignature 
   */
  async registerMachine(publicKey, installationId, selfSignature) {
    const { data, envelope } = await this._postWithRetry('/machine/register', {
      publicKey: publicKey.toString('base64'),
      installationId,
      signature: selfSignature.toString('base64')
    });
    return { machineId: data.machineId, status: data.status, signatures: envelope.signatures };
  }

  /**
   * Renews an active session.
   * @param {string} sessionId 
   * @param {number|bigint} generation 
   * @param {number|bigint} localEpoch 
   */
  async renewSession(sessionId, generation, localEpoch) {
    const { data, envelope } = await this._postWithRetry('/auth/renew', {
      sessionId,
      generation: Number(generation),
      localEpoch: Number(localEpoch)
    });
    return {
      newGeneration: envelope.generation,
      capabilities: data.capabilities,
      graceToken: data.graceToken,
      signatures: envelope.signatures
    };
  }

  /**
   * Authorizes a capability explicitly (when CP cache is insufficient).
   * @param {string} sessionId 
   * @param {string} capability 
   */
  async authorize(sessionId, capability) {
    const { data, envelope } = await this._postWithRetry('/auth/authorize', {
      sessionId,
      capability
    });
    return { authzData: data.authzData, signatures: envelope.signatures };
  }

  /**
   * Explicit logout (best effort, 1 retry).
   * @param {string} sessionId 
   */
  async logout(sessionId) {
    await this._postWithRetry('/auth/logout', { sessionId }, 1);
    return { status: "OK" };
  }

  /**
   * Reconciles DB State with Backend Authority.
   * @param {string} localStateHash 
   * @param {number|bigint} generation 
   * @param {number|bigint} epoch 
   */
  async reconcile(localStateHash, generation, epoch) {
    const { data, envelope } = await this._postWithRetry('/sync/reconcile', {
      localStateHash,
      generation: Number(generation),
      epoch: Number(epoch)
    });
    return { action: data.action, authoritativeState: data.authoritativeState, signatures: envelope.signatures };
  }
}

export const backendClient = new BackendClient();
