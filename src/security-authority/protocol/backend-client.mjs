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
    if (details && typeof details === 'object') {
      this.legacyCode = details.legacyCode;
      this.category = details.category;
      this.retryable = details.retryable;
      this.requestId = details.requestId;
    }
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
 * Covers both legacy codes and standardized BE_* error taxonomy.
 */
export const FATAL_PROTOCOL_ERRORS = new Set([
  'NONCE_EXPIRED',
  'NONCE_REPLAYED',
  'INVALID_SIGNATURE',
  'MACHINE_NOT_FOUND',
  'MACHINE_REVOKED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'GENERATION_MISMATCH',
  // Standardized BE_* Error Taxonomy
  'BE_AUTH_NONCE_EXPIRED',
  'BE_AUTH_NONCE_REPLAYED',
  'BE_AUTH_INVALID_SIGNATURE',
  'BE_AUTH_MACHINE_NOT_FOUND',
  'BE_AUTH_MACHINE_REVOKED',
  'BE_AUTH_INVALID_CREDENTIALS',
  'BE_AUTH_SESSION_EXPIRED',
  'BE_AUTH_SESSION_REVOKED',
  'BE_AUTH_ACCOUNT_LOCKED',
  'BE_REV_GENERATION_MISMATCH',
  'BE_REV_EPOCH_MISMATCH',
  'BE_VAL_SCHEMA_VIOLATION',
  'BE_STATE_ACCOUNT_EXISTS',
  'BE_PERM_ENTITLEMENT_EXCEEDED',
  'BE_PERM_LICENSE_EXPIRED',
  'BE_PERM_STEP_UP_REQUIRED',
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
          const errObj = typeof json.error === 'object' ? json.error : { message: json.error, code: json.error };
          const code = errObj.code || 'UNKNOWN_ERROR';
          const legacyCode = errObj.legacyCode;
          const message = errObj.message || 'Backend rejected request';
          const retryable = errObj.retryable ?? false;

          const isFatal = !retryable || FATAL_PROTOCOL_ERRORS.has(code) || (legacyCode && FATAL_PROTOCOL_ERRORS.has(legacyCode));
          if (isFatal) {
            throw new ProtocolError(code, message, errObj);
          }
          // Retryable error (e.g. BE_STATE_RESOURCE_LOCKED, BE_RATE_LIMIT_EXCEEDED, BE_SYS_SERVICE_UNAVAILABLE)
          throw new ProtocolError(code, message, { ...errObj, retryable: true });
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

        return { envelope: json.signatures ? json : undefined, data: decodedPayload };

      } catch (err) {
        // Bubble fatal or non-retryable errors immediately without retry
        if (err instanceof ProtocolError) {
          const isRetryable = err.retryable === true || err.code === Errors.ErrNetwork;
          if (!isRetryable) {
            throw err;
          }
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

  /**
   * Toggles betting cycle participation for an account on Backend.
   * @param {string} accountId 
   * @param {boolean} enabled 
   * @returns {Promise<any>}
   */
  async toggleBetCycle(accountId, enabled) {
    const url = `${this.endpoint}/api/v1/automation/accounts/${accountId}/bet-cycle`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(this.sessionId ? { 'Authorization': `Bearer ${this.sessionId}` } : {})
      },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) {
      throw new ProtocolError(`HTTP_${res.status}`, `Failed to toggle bet cycle for ${accountId}`);
    }
    return res.json();
  }

  /**
   * Updates per-account automation config overrides on Backend.
   * @param {string} accountId 
   * @param {string} category 
   * @param {Object} values 
   * @param {string} [source='CUSTOM']
   * @returns {Promise<any>}
   */
  async updateAccountConfigOverride(accountId, category, values, source = 'CUSTOM') {
    const { data } = await this._postWithRetry(`/api/v1/automation/accounts/${accountId}/override`, {
      category,
      source,
      values
    });
    return data;
  }

  /**
   * Fetches the billing snapshot from Backend.
   * @returns {Promise<any>}
   */
  async getBillingSnapshot() {
    return this._getWithSession('/api/v1/billing');
  }

  /**
   * Initiates payment checkout session on Backend.
   * @param {string} planId 
   * @param {string} [billingInterval='monthly'] 
   * @param {string} [returnUrl] 
   * @returns {Promise<any>}
   */
  async initiateCheckout(planId, billingInterval = 'monthly', returnUrl = undefined) {
    const { data } = await this._postWithRetry('/api/v1/billing/checkout', {
      planId,
      billingInterval,
      returnUrl
    });
    return data;
  }

  /**
   * Verifies checkout payment reference on Backend.
   * @param {string} reference 
   * @returns {Promise<any>}
   */
  async verifyCheckout(reference) {
    const { data } = await this._postWithRetry('/api/v1/billing/checkout/verify', {
      reference
    });
    return data;
  }

  /**
   * Cancels subscription auto-renewal on Backend.
   * @returns {Promise<any>}
   */
  async cancelSubscription() {
    const { data } = await this._postWithRetry('/api/v1/billing/subscription/cancel', {});
    return data;
  }

  /**
   * Resumes subscription auto-renewal on Backend.
   * @returns {Promise<any>}
   */
  async resumeSubscription() {
    const { data } = await this._postWithRetry('/api/v1/billing/subscription/resume', {});
    return data;
  }

  /**
   * Fetches subscription plans catalog from Backend with optional ETag revalidation.
   * @param {Object} [options]
   * @param {string} [options.ifNoneMatch]
   * @returns {Promise<{ notModified?: boolean; catalog?: any; etag?: string }>}
   */
  async getPlansCatalog(options = {}) {
    const url = `${this.endpoint}/api/v1/billing/plans`;
    const headers = {
      'Accept': 'application/json',
      ...(options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : {})
    };
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      return { notModified: true, etag: options.ifNoneMatch };
    }
    if (!res.ok) {
      throw new ProtocolError(`HTTP_${res.status}`, `Failed to fetch plans catalog: ${res.status}`);
    }
    const catalog = await res.json();
    return {
      notModified: false,
      catalog,
      etag: res.headers.get('etag') || undefined
    };
  }

  /**
   * Fetches platform registry catalog from Backend with optional ETag revalidation.
   * @param {Object} [options]
   * @param {string} [options.ifNoneMatch]
   * @returns {Promise<{ notModified?: boolean; registry?: any; etag?: string }>}
   */
  async getPlatformRegistry(options = {}) {
    const url = `${this.endpoint}/api/v1/platforms`;
    const headers = {
      'Accept': 'application/json',
      ...(options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : {})
    };
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      return { notModified: true, etag: options.ifNoneMatch };
    }
    if (!res.ok) {
      throw new ProtocolError(`HTTP_${res.status}`, `Failed to fetch platforms: ${res.status}`);
    }
    const registry = await res.json();
    return {
      notModified: false,
      registry,
      etag: res.headers.get('etag') || undefined
    };
  }

  /**
   * Submits settings mutation intent to Backend.
   * @param {Object} intent 
   * @returns {Promise<any>}
   */
  async submitSettingsIntent(intent) {
    const { data } = await this._postWithRetry('/api/v1/settings/intent', intent);
    return data;
  }

  /**
   * Submits diagnostic telemetry to Backend.
   * @param {Object} report 
   * @returns {Promise<any>}
   */
  async submitDiagnostics(report) {
    const { data } = await this._postWithRetry('/api/v1/support/diagnostics', report);
    return data;
  }
}

export const backendClient = new BackendClient();

