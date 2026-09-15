// @ts-check

import { engineInstance } from './decision-engine.mjs';
import { TransitionEvent } from './state-machine/transitions.mjs';
import { SecurityState } from './state-machine/states.mjs';
import { StorageAdapter } from './persistence/storage-adapter.mjs';
import { NativeCore } from './native/security-core.mjs';
import { writeSecurityEvent } from './audit/event-log.mjs';
import { SecureCdpProxy } from './execution/cdp-proxy.mjs';
import { licenseManager } from './licensing/license-manager.mjs';
import { tamperDetector } from './integrity/tamper-detector.mjs';
import { envelopeValidator } from './protocol/envelope.mjs';
import { CAPABILITY } from './authorization/capabilities.mjs';

/**
 * @typedef {Object} SecurityResult
 * @property {"AUTHENTICATED" | "DENIED" | "PARTIAL" | "OPERATIONAL" | "UNAUTHENTICATED"} status
 * @property {string} [message]
 */

/**
 * The SecurityFacade implements the single public API boundary for the 
 * Security Authority subsystem. Other subsystems (e.g., API Server, Runtime Manager) 
 * ONLY interact with this facade and NEVER internal security modules directly.
 */
export class SecurityFacade {
  /**
   * Initializes the Security Authority subsystem natively.
   * @param {string} [dbPath]
   */
  async initialize(dbPath) {
    if (!StorageAdapter._db) {
      const resolvedPath = dbPath || process.env.CP_SECURITY_DB_PATH || './data/control_plane_security.db';
      await StorageAdapter.initDatabase(resolvedPath);
    }
    await engineInstance.initialize();
  }

  /**
   * Authenticates a user.
   * @param {any} credentials 
   * @returns {Promise<SecurityResult>}
   */
  async authenticate(credentials) {
    const loginIntentSuccess = await engineInstance.dispatch(TransitionEvent.LOGIN_INTENT, credentials);
    if (!loginIntentSuccess) {
      return { status: "DENIED", message: "Login intent rejected by state machine" };
    }

    // In reality this calls the protocol/backend-client layer
    // Mocking success based on backend response:
    const backendResponse = { nonceValidated: true, isBackendResponse: true };
    const authSuccess = await engineInstance.dispatch(TransitionEvent.BACKEND_AUTH_SUCCESS, backendResponse);

    if (authSuccess) {
      // Automatic authorization resolution chained per plan (§15)
      const authzResponse = { backendConfirmed: true };
      const authzSuccess = await engineInstance.dispatch(TransitionEvent.AUTHZ_LICENSE_RESOLVED, authzResponse);
      
      if (authzSuccess) {
        return { status: "OPERATIONAL" };
      }
      return { status: "PARTIAL", message: "Authenticated but Authorization failed" };
    }

    return { status: "DENIED", message: "Backend authentication failed" };
  }

  /**
   * Provisions a full-capability Developer Operational session.
   * Used in local development when the cloud backend is offline/unreachable.
   * Ensures system is in OPERATIONAL state with all capabilities granted,
   * unsetting native revocation flags and updating persistent storage.
   */
  async initDevSession() {
    // 1. Clear native FFI revocation flag
    NativeCore.setRevokedSync(false);

    const devSession = {
      sessionId: 'dev-session-001',
      status: 'AUTHENTICATED',
      userId: 'dev-operator',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 86400000 * 365
    };

    const allCaps = Object.values(CAPABILITY);
    const devAuthz = {
      status: 'VALID',
      capability_set: allCaps
    };

    const currentState = this.getSystemState();

    // 2. If at initial boot states, transition cleanly via state machine
    if (currentState === SecurityState.SECURITY_STATE_READY || currentState === SecurityState.UNAUTHENTICATED) {
      await engineInstance.dispatch(TransitionEvent.LOGIN_INTENT, { sessionData: devSession });
      await engineInstance.dispatch(TransitionEvent.BACKEND_AUTH_SUCCESS, {
        nonceValidated: true,
        sessionData: devSession
      });
      await engineInstance.dispatch(TransitionEvent.AUTHZ_LICENSE_RESOLVED, {
        backendConfirmed: true,
        authorizationData: devAuthz,
        licenseData: { status: 'VALID' }
      });
    } else if (currentState === SecurityState.OFFLINE_GRACE) {
      // Reconnect from offline grace
      await engineInstance.dispatch(TransitionEvent.BACKEND_RECONNECTED, {
        handshakePassed: true,
        authorizationData: devAuthz,
        sessionData: devSession
      });
    }

    // 3. Ensure inMemoryState is OPERATIONAL with full capabilities
    if (engineInstance.inMemoryState) {
      engineInstance.inMemoryState.state = SecurityState.OPERATIONAL;
      engineInstance.inMemoryState.session = devSession;
      engineInstance.inMemoryState.authorization = devAuthz;
      engineInstance.inMemoryState.license = { status: 'VALID' };

      // Ensure persistent row is synchronized if storage is initialized
      try {
        const row = await StorageAdapter.getSecurityStateRow();
        if (row && row.state !== SecurityState.OPERATIONAL) {
          await StorageAdapter.commitTransitionWithOCC(row.state_version, engineInstance.inMemoryState, 'DEV_MODE_OPERATIONAL');
        }
      } catch { /* ignore storage error in memory/test modes */ }
    }
  }

  /**
   * Authorizes an action against the currently valid capability set.
   * @param {import('./authorization/capabilities.mjs').Capability} capability 
   * @returns {SecurityResult}
   */
  authorize(capability) {
    // Canonical §48: Non-security config modify is permitted (not entitlement-gated).
    // Safety invariant: Emergency stop is always permitted.
    if (capability === CAPABILITY.CONFIG_MODIFY || capability === CAPABILITY.AUTOMATION_STOP) {
      return { status: "OPERATIONAL" };
    }

    const capabilities = engineInstance.getCurrentCapabilities();
    if (capabilities.includes(capability)) {
      return { status: "OPERATIONAL" };
    }
    return { status: "DENIED", message: `Missing capability: ${capability}` };
  }

  /**
   * Registers dynamic check function for active execution runtime.
   * @param {() => boolean} fn
   */
  setActiveExecutionChecker(fn) {
    engineInstance.setActiveExecutionChecker(fn);
  }

  /**
   * Revokes the current session explicitly.
   */
  async logout() {
    await engineInstance.dispatch(TransitionEvent.LOGOUT_INTENT, {});
    await engineInstance.dispatch(TransitionEvent.LOGOUT_SEQUENCE_COMPLETE, { allStepsCompleted: true });
  }

  /**
   * Returns the current strict state enum of the Security Authority.
   * Useful for health-checks and global guard middleware.
   * @returns {import('./state-machine/states.mjs').SecurityStateEnum | "UNINITIALIZED"}
   */
  getSystemState() {
    if (!engineInstance.inMemoryState) return "UNINITIALIZED";
    return engineInstance.inMemoryState.state;
  }

  /**
   * Returns true if system is in full OPERATIONAL state.
   * @returns {boolean}
   */
  isOperational() {
    return this.getSystemState() === SecurityState.OPERATIONAL;
  }

  /**
   * Returns true if system is degraded, offline, revoked, or uninitialized.
   * In any of these states, Execution Plane access is strictly forbidden.
   * @returns {boolean}
   */
  isDegraded() {
    const s = this.getSystemState();
    return s !== SecurityState.OPERATIONAL;
  }

  /**
   * Explicitly triggers transition to OFFLINE_GRACE / degraded state when backend or internet drops.
   * @param {string} [reason]
   * @returns {Promise<boolean>}
   */
  async transitionToDegraded(reason = 'BACKEND_UNREACHABLE') {
    const currentState = this.getSystemState();
    if (currentState === SecurityState.OPERATIONAL) {
      // Must first transition via RENEW_THRESHOLD_REACHED or RENEW_BACKEND_UNREACHABLE
      await engineInstance.dispatch(TransitionEvent.RENEW_THRESHOLD_REACHED, {
        now: Date.now() + 10000,
        renewAfter: 0,
        renewalMutexHeld: false
      });
      return await engineInstance.dispatch(TransitionEvent.RENEW_BACKEND_UNREACHABLE, { reason });
    }
    return true;
  }

  /**
   * Synchronously determines if the current session has been forcefully revoked.
   * This is a hot-path method designed to be called rapidly without blocking the event loop.
   * @returns {boolean}
   */
  isSessionRevokedSync() {
    return NativeCore.isRevokedSync();
  }

  /**
   * Verifies the cryptographic binding of this node to its underlying hardware.
   * @returns {boolean} True if the machine identity matches the root DPAPI vault.
   */
  verifyMachineIdentitySync() {
    return NativeCore.verifyMachineIdentitySync();
  }

  /**
   * Provisions a high-security local IPC named pipe bound exclusively 
   * to the current system user and validated process trees.
   * @param {string} pipeName 
   * @param {function(number): void} onConnection 
   * @param {function(number, Buffer): void} onData 
   * @param {function(number): void} onDisconnect 
   */
  startSecureIPC(pipeName, onConnection, onData, onDisconnect) {
    return NativeCore.startSecurePipeServer(pipeName, onConnection, onData, onDisconnect);
  }

  /**
   * Shuts down the secure IPC pipe.
   */
  stopSecureIPC() {
    NativeCore.stopSecurePipeServer();
  }

  /**
   * Writes a highly secure, non-repudiable audit event to the security log.
   * This automatically strips secrets from metadata per canonical security specifications.
   * @param {string} eventType 
   * @param {"INFO" | "WARN" | "SIGNIFICANT" | "CRITICAL"} severity 
   * @param {Record<string, unknown>} metadata 
   */
  async logAuditEvent(eventType, severity, metadata = {}) {
    if (!engineInstance.inMemoryState) throw new Error("Security Engine offline");
    await writeSecurityEvent(eventType, severity, engineInstance.inMemoryState, metadata);
  }

  /**
   * Synchronously proxies the Chrome DevTools Protocol (CDP) streams while 
   * enforcing the cryptographic revocation kill-switch.
   * @param {NodeJS.ReadableStream} browserOut 
   * @param {NodeJS.WritableStream} browserIn 
   * @param {NodeJS.WritableStream} consumerOut 
   * @param {NodeJS.ReadableStream} consumerIn 
   * @param {Function} killRuntime 
   */
  proxyExecutionStreams(browserOut, browserIn, consumerOut, consumerIn, killRuntime) {
    SecureCdpProxy.proxyStreams(browserOut, browserIn, consumerOut, consumerIn, killRuntime);
  }

  /**
   * Validates the Ed25519 cryptographic signature of a license payload.
   * @param {Object} licensePayload 
   * @param {string} serverTrustPubHex 
   * @returns {boolean}
   */
  validateLicenseIntegrity(licensePayload, serverTrustPubHex) {
    return licenseManager.validateLicenseIntegrity(licensePayload, serverTrustPubHex);
  }

  /**
   * Verifies an arbitrary asset's integrity signature using the Server Trust Key.
   * @param {Buffer} assetBuffer 
   * @param {string} signatureHex 
   * @param {string} serverTrustPubHex 
   * @returns {boolean}
   */
  verifyAssetIntegrity(assetBuffer, signatureHex, serverTrustPubHex) {
    return tamperDetector.verifyAssetIntegrity(assetBuffer, signatureHex, serverTrustPubHex);
  }

  /**
   * Authenticates an incoming Control Plane Protocol Envelope (verifying pinned keys and structure).
   * @param {any} envelope 
   * @returns {boolean}
   */
  validateProtocolEnvelope(envelope) {
    return envelopeValidator.validateEnvelope(envelope);
  }
}

export const securityFacade = new SecurityFacade();
