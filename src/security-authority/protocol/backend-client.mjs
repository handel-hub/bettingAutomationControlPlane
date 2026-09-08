// @ts-check

import crypto from 'crypto';
import { envelopeValidator } from './envelope.mjs';
import { machineIdentity as defaultMachineIdentity } from '../identity/machine-identity.mjs';

/**
 * Custom Error Definitions for Protocol
 */
export class ProtocolError extends Error {
  /**
   * @param {string} code 
   * @param {string} message 
   * @param {any} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  ErrNetwork: 'ErrNetwork',
  ErrInvalidCredentials: 'ErrInvalidCredentials',
  ErrMachineBanned: 'ErrMachineBanned',
  ErrDuplicateInstallation: 'ErrDuplicateInstallation',
  ErrInvalidSignature: 'ErrInvalidSignature',
  ErrSessionExpired: 'ErrSessionExpired',
  ErrGenerationMismatch: 'ErrGenerationMismatch',
  ErrEpochMismatch: 'ErrEpochMismatch',
  ErrRevoked: 'ErrRevoked',
  ErrSuspended: 'ErrSuspended',
  ErrUnknownEpoch: 'ErrUnknownEpoch',
  ErrFatalProtocol: 'ErrFatalProtocol'
};

/**
 * Fatal error codes from Backend that MUST NOT trigger network retries.
 */
const FATAL_PROTOCOL_ERRORS = new Set([
  'NONCE_EXPIRED',
  'NONCE_REPLAYED',
  'INVALID_SIGNATURE',
  'MACHINE_NOT_FOUND',
  'MACHINE_REVOKED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'GENERATION_MISMATCH',
  Errors.ErrInvalidCredentials,
  Errors.ErrInvalidSignature,
  Errors.ErrRevoked,
  Errors.ErrMachineBanned
]);

/**
 * Handles resilient, machine-authenticated communication with the Cloud Backend.
 * Manages Envelope V2 semantics, exponential backoff for network transient errors,
 * and authoritative state synchronization.
 */
export class BackendClient {
  /**
   * @param {string} [endpoint]
   * @param {import('../identity/machine-identity.mjs').MachineIdentity} [identity]
   */
  constructor(endpoint, identity = defaultMachineIdentity) {
    this.endpoint = endpoint || process.env.BACKEND_URL || process.env.BACKEND_API_URL || "http://127.0.0.1:3001";
    this.machineIdentity = identity;

    /** @type {string | null} */
    this.sessionId = null;
    /** @type {string | null} */
    this.machineId = null;
    /** @type {number} */
    this.clientGeneration = 1;
    /** @type {number} */
    this.clientServerEpoch = 1;
  }

  /**
   * Returns the current session context for signing outbound envelopes.
   */
  getSessionContext() {
    return {
      sessionId: this.sessionId || '',
      machineId: this.machineId || '',
      clientGeneration: this.clientGeneration,
      clientServerEpoch: this.clientServerEpoch
    };
  }

  /**
   * Sets active session parameters.
   * @param {string} sessionId 
   * @param {string} [machineId] 
   * @param {number} [generation]
   */
  setSession(sessionId, machineId, generation = 1) {
    this.sessionId = sessionId;
    if (machineId) this.machineId = machineId;
    this.clientGeneration = generation;
  }

  /**
   * Internal HTTP POST wrapper with exponential backoff for network-level failures.
   * Does NOT retry semantic/protocol errors.
   * @param {string} path 
   * @param {Object} data 
   * @param {number} [maxRetries=3]
   * @returns {Promise<{ envelope?: any; data: any }>}
   */
  async _postWithRetry(path, data, maxRetries = 3) {
    const url = `${this.endpoint}${path}`;
    const requestEnvelope = envelopeValidator.createRequest(data, this.machineIdentity, this.getSessionContext());

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            ...(this.sessionId ? { 'Authorization': `Bearer ${this.sessionId}`, 'x-session-id': this.sessionId } : {}),
            ...(this.machineId ? { 'x-machine-id': this.machineId } : {})
          },
          body: JSON.stringify(requestEnvelope)
        });

        if (response.status >= 500 && response.status < 600) {
          throw new ProtocolError(Errors.ErrNetwork, `Server Error: ${response.status}`);
        }

        const json = await response.json();

        // 1. If backend returns an explicit protocol or domain error
        if (json.error) {
          const code = typeof json.error === 'string' ? json.error : (json.error.code || 'UNKNOWN_ERROR');
          const message = typeof json.error === 'string' ? json.error : (json.error.message || 'Backend rejected request');

          // If it's a fatal protocol error, never retry
          if (FATAL_PROTOCOL_ERRORS.has(code)) {
            throw new ProtocolError(code, message, json.error);
          }
          throw new ProtocolError(code, message, json.error);
        }

        // 2. Cryptographic Validation Pipeline if response is wrapped in an envelope
        if (json.signatures && typeof json.signatures === 'object') {
          if (!envelopeValidator.validateEnvelope(json)) {
            throw new ProtocolError(Errors.ErrInvalidSignature, "Backend response failed cryptographic signature or freshness checks.");
          }
        }

        // 3. Extract payload: decode base64 or read JSON object directly
        let decodedPayload = json.payload !== undefined ? json.payload : json;
        if (typeof decodedPayload === 'string') {
          try {
            const buf = Buffer.from(decodedPayload, 'base64');
            decodedPayload = JSON.parse(buf.toString('utf8'));
          } catch {
            // Leave as string if not base64 JSON
          }
        }

        // Increment local client generation counter on successful mutation
        this.clientGeneration++;

        return { envelope: json.signatures ? json : undefined, data: decodedPayload };

      } catch (err) {
        // Bubble fatal or semantic errors immediately without retry
        if (err instanceof ProtocolError && (err.code !== Errors.ErrNetwork || FATAL_PROTOCOL_ERRORS.has(err.code))) {
          throw err;
        }

        attempt++;
        if (attempt > maxRetries) {
          throw new ProtocolError(Errors.ErrNetwork, `Network/Fetch failure after ${maxRetries} retries: ${err.message}`);
        }

        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delay = Math.pow(2, attempt - 1) * 500;
        await new Promise(res => setTimeout(res, delay));
      }
    }

    throw new ProtocolError(Errors.ErrNetwork, `Network request failed after ${maxRetries} attempts`);
  }

  /**
   * Internal HTTP GET wrapper with session authentication headers.
   * @param {string} path 
   * @param {Record<string, any>} [queryParams]
   * @returns {Promise<any>}
   */
  async _getWithSession(path, queryParams = {}) {
    let url = `${this.endpoint}${path}`;
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) searchParams.append(k, String(v));
    }
    const queryString = searchParams.toString();
    if (queryString) url += `?${queryString}`;

    const headers = {
      'Accept': 'application/json',
      ...(this.sessionId ? { 'Authorization': `Bearer ${this.sessionId}`, 'x-session-id': this.sessionId } : {}),
      ...(this.machineId ? { 'x-machine-id': this.machineId } : {})
    };

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
      throw new ProtocolError(`HTTP_${res.status}`, parsed.error || `GET ${path} failed with status ${res.status}`);
    }

    return res.json();
  }

  /**
   * Checks Backend server health.
   * @returns {Promise<{ ok: boolean; status: string }>}
   */
  async checkHealth() {
    try {
      const res = await fetch(`${this.endpoint}/health/live`);
      if (res.ok) {
        const json = await res.json();
        return { ok: true, status: json.status || 'ok' };
      }
      return { ok: false, status: `HTTP_${res.status}` };
    } catch (err) {
      return { ok: false, status: err.message };
    }
  }

  /**
   * Registers a Machine Identity with the Backend.
   * @param {string|Buffer} publicKey 
   * @param {string} installationId 
   * @param {string|Buffer} selfSignature 
   * @param {Object} [descriptor]
   */
  async registerMachine(publicKey, installationId, selfSignature, descriptor = {}) {
    const pubKeyHex = typeof publicKey === 'string' ? publicKey : publicKey.toString('hex');
    const sigHex = typeof selfSignature === 'string' ? selfSignature : selfSignature.toString('hex');

    const { data, envelope } = await this._postWithRetry('/api/v1/machines/register', {
      installationId,
      publicKeyHex: pubKeyHex,
      selfSignature: sigHex,
      descriptor
    });

    if (data.machineId) {
      this.machineId = data.machineId;
    }

    return {
      machineId: data.machineId,
      status: data.status,
      signatures: envelope?.signatures
    };
  }

  /**
   * Initializes user/machine authentication with the Backend.
   * @param {Object} credentials 
   * @param {string} credentials.email 
   * @param {string} credentials.password 
   * @param {string} [clientNonce]
   */
  async initAuth(credentials, clientNonce) {
    const nonce = clientNonce || crypto.randomBytes(16).toString('hex');
    const { data, envelope } = await this._postWithRetry('/api/v1/auth/init', {
      email: credentials.email,
      password: credentials.password,
      machineId: this.machineId,
      protocolVersion: 2,
      clientNonce: nonce
    });

    if (data.sessionId) {
      this.sessionId = data.sessionId;
    }
    if (data.sessionGeneration) {
      this.clientGeneration = data.sessionGeneration;
    }

    return {
      sessionId: data.sessionId,
      accountId: data.accountId,
      sessionGeneration: data.sessionGeneration,
      nonceValidated: data.nonceValidated,
      license: data.license,
      capabilities: data.capabilities,
      signatures: envelope?.signatures
    };
  }

  /**
   * Renews an active session.
   * @param {string} [sessionId] 
   * @param {number|bigint} [generation] 
   * @param {number|bigint} [localEpoch] 
   */
  async renewSession(sessionId, generation, localEpoch) {
    const activeSessionId = sessionId || this.sessionId;
    const { data, envelope } = await this._postWithRetry('/api/v1/sessions/renew', {
      sessionId: activeSessionId,
      generation: Number(generation ?? this.clientGeneration),
      localEpoch: Number(localEpoch ?? this.clientServerEpoch)
    });

    if (envelope?.generation) {
      this.clientGeneration = Number(envelope.generation);
    }

    return {
      newGeneration: envelope?.generation,
      capabilities: data.capabilities,
      graceToken: data.graceToken,
      signatures: envelope?.signatures
    };
  }

  /**
   * Authorizes a capability explicitly.
   * @param {string} capability 
   */
  async authorize(capability) {
    const { data, envelope } = await this._postWithRetry('/api/v1/authorization/resolve', {
      sessionId: this.sessionId,
      capability
    });
    return { authzData: data.authzData, signatures: envelope?.signatures };
  }

  /**
   * Explicit logout.
   */
  async logout() {
    if (!this.sessionId) return { status: 'OK' };
    try {
      await this._postWithRetry('/api/v1/sessions/logout', { sessionId: this.sessionId }, 1);
    } catch {
      // Ignore network errors on logout
    }
    this.sessionId = null;
    return { status: 'OK' };
  }

  /**
   * Reconciles local state with Backend.
   * @param {string} localStateHash 
   * @param {number|bigint} [generation] 
   * @param {number|bigint} [epoch] 
   */
  async reconcile(localStateHash, generation, epoch) {
    const { data, envelope } = await this._postWithRetry('/api/v1/reconciliation/sync', {
      localStateHash,
      generation: Number(generation ?? this.clientGeneration),
      epoch: Number(epoch ?? this.clientServerEpoch)
    });
    return { 
      action: data.action, 
      authoritativeState: data.authoritativeState, 
      signatures: envelope?.signatures 
    };
  }

  /**
   * Fetches the authoritative Automation Workspace Snapshot from the Backend.
   * @returns {Promise<any>}
   */
  async getAutomationSnapshot() {
    return this._getWithSession('/api/v1/automation/snapshot');
  }

  /**
   * Fetches operator betting accounts from the Backend.
   * @param {Object} [options]
   * @param {number} [options.offset]
   * @param {number} [options.limit]
   * @param {string} [options.sortBy]
   * @param {string} [options.sortOrder]
   * @param {string} [options.filterQuery]
   * @returns {Promise<any>}
   */
  async getBettingAccounts(options = {}) {
    return this._getWithSession('/api/v1/accounts', options);
  }

  /**
   * Registers a new betting account on the Backend.
   * @param {Object} accountData 
   * @returns {Promise<any>}
   */
  async createBettingAccount(accountData) {
    const { data } = await this._postWithRetry('/api/v1/accounts', accountData);
    return data;
  }

  /**
   * Executes an action on a betting account.
   * @param {string} accountId 
   * @param {string} actionType 
   */
  async executeAccountAction(accountId, actionType) {
    const { data } = await this._postWithRetry(`/api/v1/accounts/${accountId}/action`, { type: actionType });
    return data;
  }

  /**
   * Updates global automation configuration on the Backend.
   * @param {string} category 
   * @param {Object} values 
   */
  async updateGlobalConfig(category, values) {
    const url = `${this.endpoint}/api/v1/automation/config/${category}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(this.sessionId ? { 'Authorization': `Bearer ${this.sessionId}` } : {})
      },
      body: JSON.stringify({ values })
    });
    if (!res.ok) {
      throw new ProtocolError(`HTTP_${res.status}`, `Failed to update global config for ${category}`);
    }
    return res.json();
  }

  /**
   * FTS: Initializes a chunked file transfer.
   * @param {Object} params 
   */
  async initializeTransfer(params) {
    const { data } = await this._postWithRetry('/api/v1/transfers/initialize', params);
    return data;
  }

  /**
   * FTS: Uploads a single transfer chunk.
   * @param {Object} params 
   */
  async uploadChunk(params) {
    const { remoteSessionId, offset, data: chunkData } = params;
    const base64Data = Buffer.isBuffer(chunkData) ? chunkData.toString('base64') : chunkData;
    const { data } = await this._postWithRetry(`/api/v1/transfers/${remoteSessionId}/chunks`, {
      offset,
      data: base64Data
    });
    return data;
  }

  /**
   * FTS: Completes a chunked file transfer.
   * @param {Object} params 
   */
  async completeTransfer(params) {
    const { remoteSessionId } = params;
    const { data } = await this._postWithRetry(`/api/v1/transfers/${remoteSessionId}/complete`, params);
    return data;
  }

  /**
   * FTS: Queries transfer status for reconciliation.
   * @param {Object} params 
   */
  async queryTransferStatus(params) {
    const { remoteSessionId } = params;
    return this._getWithSession(`/api/v1/transfers/${remoteSessionId}/status`);
  }
}

export const backendClient = new BackendClient();

