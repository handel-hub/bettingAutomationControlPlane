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
import { initClock } from './time/clock.mjs';

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
    await initClock();
    await engineInstance.initialize();
  }

  /**
   * Establishes an authenticated session from authoritative backend login or cached session.
   * Dispatches LOGIN_INTENT -> BACKEND_AUTH_SUCCESS -> AUTHZ_LICENSE_RESOLVED cleanly.
   * @param {Object} authPayload
   * @param {string} authPayload.sessionId
   * @param {string} [authPayload.accountId]
   * @param {number} [authPayload.expiresInMs]
   * @param {string[]} [authPayload.capabilities]
   * @param {Object} [authPayload.license]
   * @returns {Promise<SecurityResult>}
   */
  async establishSession(authPayload) {
    if (!engineInstance.inMemoryState) {
      await this.initialize();
    }

    if (!authPayload || !authPayload.sessionId) {
      return { status: "DENIED", message: "Invalid session payload" };
    }

    const licenseData = authPayload.license || { status: 'VALID' };
    if (licenseData.status === 'REVOKED') {
      await this.revokeLicense('LICENSE_REVOKED_AT_AUTH');
      return { status: "DENIED", message: "License is revoked" };
    }

    const sessionData = {
      sessionId: authPayload.sessionId,
      status: 'AUTHENTICATED',
      userId: authPayload.accountId || 'authenticated-operator',
      issuedAt: Date.now(),
      expiresAt: Date.now() + (authPayload.expiresInMs || 86400000)
    };

    const rawCaps = Array.isArray(authPayload.capabilities)
      ? authPayload.capabilities
      : Object.values(CAPABILITY);

    const expandedCaps = new Set(rawCaps);
    if (expandedCaps.has('CAP_CASH_OUT')) expandedCaps.add('CAP_BET_CASHOUT');
    if (expandedCaps.has('CAP_BET_CASHOUT')) expandedCaps.add('CAP_CASH_OUT');
    if (expandedCaps.has('CAP_TACTICAL_BET')) {
      expandedCaps.add('CAP_BET_PLACE');
      expandedCaps.add('CAP_BET_VALIDATE');
    }
    if (expandedCaps.has('CAP_BET_PLACE')) expandedCaps.add('CAP_TACTICAL_BET');
    if (expandedCaps.has('CAP_CONFIG_MODIFY')) expandedCaps.add('CAP_ACCOUNT_MANAGE');

    const requiresSignatureCheck = Boolean(licenseData.signature) || process.env.NODE_ENV === 'production';
    const hasValidSignature = requiresSignatureCheck
      ? this.validateLicenseIntegrity(licenseData)
      : true;

    const isLicenseValid = licenseData.status === 'VALID' && hasValidSignature && expandedCaps.size > 0;

    const authorizationData = {
      status: isLicenseValid
        ? 'VALID'
        : (!hasValidSignature ? 'LICENSE_SIGNATURE_INVALID' : (licenseData.status || 'PAYMENT_REQUIRED')),
      capability_set: isLicenseValid ? Array.from(expandedCaps) : []
    };

    const currentState = this.getSystemState();

    if (currentState === SecurityState.OFFLINE_GRACE && isLicenseValid) {
      const reconnected = await engineInstance.dispatch(TransitionEvent.BACKEND_RECONNECTED, {
        handshakePassed: true,
        authorizationData,
        licenseData,
        sessionData
      });
      if (reconnected) {
        NativeCore.setRevokedSync(false);
        return { status: "OPERATIONAL" };
      }
    }

    const loginEligibleStates = new Set([
      SecurityState.SECURITY_STATE_READY,
      SecurityState.UNAUTHENTICATED,
      SecurityState.REAUTHENTICATION_REQUIRED,
      SecurityState.LOGGED_OUT,
      SecurityState.AUTH_FAILED,
      SecurityState.AUTHZ_FAILURE,
      SecurityState.EXPIRED,
      SecurityState.AUTHENTICATED,
      SecurityState.OPERATIONAL
    ]);

    if (loginEligibleStates.has(/** @type {any} */ (currentState))) {
      const initEvent = currentState === SecurityState.REAUTHENTICATION_REQUIRED
        ? TransitionEvent.USER_REINITIATES
        : TransitionEvent.LOGIN_INTENT;
      const loginIntentSuccess = await engineInstance.dispatch(initEvent, { sessionData });
      if (!loginIntentSuccess) {
        return { status: "DENIED", message: "Login intent rejected by state machine" };
      }

      const authSuccess = await engineInstance.dispatch(TransitionEvent.BACKEND_AUTH_SUCCESS, {
        nonceValidated: true,
        sessionData,
        authorizationData,
        licenseData
      });
      if (!authSuccess) {
        return { status: "DENIED", message: "Backend authentication transition rejected" };
      }

      if (!isLicenseValid) {
        NativeCore.setRevokedSync(false);
        return {
          status: "AUTHENTICATED",
          message: !hasValidSignature
            ? 'License cryptographic signature verification failed'
            : `Active subscription/license required (${licenseData.status || 'PAYMENT_REQUIRED'})`
        };
      }

      const authzSuccess = await engineInstance.dispatch(TransitionEvent.AUTHZ_LICENSE_RESOLVED, {
        backendConfirmed: true,
        authorizationData,
        licenseData
      });

      if (authzSuccess) {
        NativeCore.setRevokedSync(false);
        return { status: "OPERATIONAL" };
      }
      return { status: "PARTIAL", message: "Authenticated but Authorization failed" };
    }

    return { status: /** @type {any} */ (this.getSystemState()) };
  }

  /**
   * Authenticates a user or session.
   * @param {any} credentials 
   * @returns {Promise<SecurityResult>}
   */
  async authenticate(credentials) {
    if (credentials && credentials.sessionId) {
      return this.establishSession(credentials);
    }
    if (process.env.NODE_ENV === 'production') {
      return { status: "DENIED", message: "Unverified local session fabrication is forbidden in production" };
    }
    const sessionData = {
      sessionId: `sess_${Date.now()}`,
      status: 'AUTHENTICATED',
      userId: credentials?.email || 'operator',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 86400000
    };
    return this.establishSession({
      sessionId: sessionData.sessionId,
      accountId: sessionData.userId,
      capabilities: Object.values(CAPABILITY)
    });
  }

  /**
   * Authorizes an action against the currently valid capability set.
   * @param {import('./authorization/capabilities.mjs').Capability} capability 
   * @returns {SecurityResult}
   */
  authorize(capability) {
    // Safety invariant: Emergency stop is always permitted.
    if (capability === CAPABILITY.AUTOMATION_STOP) {
      return { status: "OPERATIONAL" };
    }

    const capabilities = engineInstance.getCurrentCapabilities();
    if (capabilities.includes(capability)) {
      return { status: "OPERATIONAL" };
    }

    // Bidirectional alias mapping between Backend and Control Plane capability naming conventions
    const aliasMap = {
      'CAP_BET_CASHOUT': 'CAP_CASH_OUT',
      'CAP_CASH_OUT': 'CAP_BET_CASHOUT',
      'CAP_BET_PLACE': 'CAP_TACTICAL_BET',
      'CAP_TACTICAL_BET': 'CAP_BET_PLACE',
      'CAP_BET_VALIDATE': 'CAP_TACTICAL_BET'
    };

    const targetAlias = aliasMap[capability];
    if (targetAlias && capabilities.includes(targetAlias)) {
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
   * Revokes the current session explicitly and persists the cleared state to disk.
   */
  async logout() {
    await engineInstance.dispatch(TransitionEvent.LOGOUT_INTENT, {});
    await engineInstance.dispatch(TransitionEvent.LOGOUT_SEQUENCE_COMPLETE, { allStepsCompleted: true });
    if (engineInstance.inMemoryState) {
      engineInstance.inMemoryState.session = null;
      engineInstance.inMemoryState.authorization = null;
      engineInstance.inMemoryState.license = null;
      try {
        const row = await StorageAdapter.getSecurityStateRow();
        if (row) {
          const committed = await StorageAdapter.commitTransitionWithOCC(
            row.state_version,
            {
              ...engineInstance.inMemoryState,
              state: SecurityState.LOGGED_OUT,
              session: null,
              authorization: null,
              license: null
            },
            TransitionEvent.LOGOUT_SEQUENCE_COMPLETE
          );
          if (committed) {
            engineInstance.inMemoryState.state_version = row.state_version + 1;
          }
        }
      } catch {
        // Ignore storage error during logout cleanup
      }
    }
  }

  /**
   * Transitions the security authority to UNAUTHENTICATED when no active operator session exists.
   */
  async transitionToUnauthenticated() {
    if (!engineInstance.inMemoryState) {
      await this.initialize();
    }
    const s = this.getSystemState();
    if (s === SecurityState.SECURITY_STATE_READY || s === SecurityState.AUTH_FAILED || s === SecurityState.LOGGED_OUT) {
      if (engineInstance.inMemoryState) {
        engineInstance.inMemoryState.state = SecurityState.UNAUTHENTICATED;
        engineInstance.inMemoryState.session = null;
        engineInstance.inMemoryState.authorization = null;
        try {
          const row = await StorageAdapter.getSecurityStateRow();
          if (row && row.state !== SecurityState.UNAUTHENTICATED) {
            const committed = await StorageAdapter.commitTransitionWithOCC(
              row.state_version,
              {
                ...engineInstance.inMemoryState,
                state: SecurityState.UNAUTHENTICATED,
                session: null,
                authorization: null
              },
              'TRANSITION_TO_UNAUTHENTICATED'
            );
            if (committed) {
              engineInstance.inMemoryState.state_version = row.state_version + 1;
            }
          }
        } catch {
          // Ignore storage error
        }
      }
    }
  }

  /**
   * Returns current session metadata if available.
   */
  getSessionInfo() {
    return engineInstance.inMemoryState?.session || null;
  }

  /**
   * Returns current license metadata if available.
   */
  getLicenseInfo() {
    return engineInstance.inMemoryState?.license || null;
  }

  /**
   * Returns complete in-memory security authority state snapshot.
   */
  getFullSecurityState() {
    return engineInstance.inMemoryState || null;
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
   * Returns true if system is degraded, offline, or revoked.
   * @returns {boolean}
   */
  isDegraded() {
    const s = this.getSystemState();
    if (s === "UNINITIALIZED") return false;
    return s !== SecurityState.OPERATIONAL && s !== SecurityState.OFFLINE_GRACE;
  }

  /**
   * Enters OFFLINE_GRACE mode when backend is unreachable but valid cached lease exists.
   * @param {Object} [leaseData]
   * @returns {Promise<boolean>}
   */
  async enterOfflineGrace(leaseData = {}) {
    const currentState = this.getSystemState();
    if (currentState === SecurityState.SECURITY_STATE_READY || currentState === SecurityState.UNAUTHENTICATED) {
      const success = await engineInstance.dispatch(TransitionEvent.ENTER_OFFLINE_GRACE, {
        isWithinGrace: true,
        ...leaseData
      });
      if (success) {
        NativeCore.setRevokedSync(false);
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Explicitly triggers transition to degraded state when backend or internet drops and grace is unavailable.
   * @param {string} [reason]
   * @returns {Promise<boolean>}
   */
  async transitionToDegraded(reason = 'BACKEND_UNREACHABLE') {
    const currentState = this.getSystemState();

    if (reason === 'OFFLINE_GRACE') {
      if (currentState === SecurityState.OPERATIONAL) {
        await engineInstance.dispatch(TransitionEvent.RENEW_THRESHOLD_REACHED, {
          now: Date.now() + 10000,
          renewAfter: 0,
          renewalMutexHeld: false
        });
        await engineInstance.dispatch(TransitionEvent.RENEW_BACKEND_UNREACHABLE, { reason });
        NativeCore.setRevokedSync(false);
        return true;
      } else if (currentState === SecurityState.OFFLINE_GRACE) {
        NativeCore.setRevokedSync(false);
        return true;
      } else {
        return this.enterOfflineGrace();
      }
    }

    if (currentState === SecurityState.OPERATIONAL) {
      // Must first transition via RENEW_THRESHOLD_REACHED or RENEW_BACKEND_UNREACHABLE
      await engineInstance.dispatch(TransitionEvent.RENEW_THRESHOLD_REACHED, {
        now: Date.now() + 10000,
        renewAfter: 0,
        renewalMutexHeld: false
      });
      await engineInstance.dispatch(TransitionEvent.RENEW_BACKEND_UNREACHABLE, { reason });
      await engineInstance.dispatch(TransitionEvent.OFFLINE_GRACE_EXHAUSTED, {
        accumulatedMs: 7200001,
        offlineGraceMax: 7200000
      });
      NativeCore.setRevokedSync(true);
      return true;
    } else if (currentState === SecurityState.OFFLINE_GRACE) {
      await engineInstance.dispatch(TransitionEvent.OFFLINE_GRACE_EXHAUSTED, {
        accumulatedMs: 7200001,
        offlineGraceMax: 7200000
      });
      NativeCore.setRevokedSync(true);
      return true;
    } else {
      NativeCore.setRevokedSync(true);
      return true;
    }
  }

  /**
   * Evaluates if a given command is permitted given the current security state (CAN-20 / DEF-20).
   * Tactical operator and safety commands (EMERGENCY_STOP, STOP_AUTOMATION, CANCEL_ALL_BETS, FREEZE_ACCOUNT, VIEW_STATUS)
   * and administrative config/persistence commands are permitted in both OPERATIONAL and OFFLINE_GRACE states.
   * Automated betting/execution dispatch commands are strictly blocked when degraded.
   * In REVOKED state, all commands except emergency stops and status view are strictly blocked.
   * @param {string} commandType
   * @returns {boolean}
   */
  isCommandPermitted(commandType) {
    const s = this.getSystemState();
    
    // In REVOKED, COMPROMISED, or TAMPER_SUSPECTED state, hard lockdown: only emergency containment stops and view status are permitted
    if (
      s === SecurityState.REVOKED ||
      s === SecurityState.COMPROMISED ||
      s === SecurityState.TAMPER_SUSPECTED ||
      this.isSessionRevokedSync()
    ) {
      return (
        commandType === 'EMERGENCY_STOP' ||
        commandType === 'STOP_AUTOMATION' ||
        commandType === 'VIEW_STATUS' ||
        commandType === 'GET_HEALTH'
      );
    }

    if (this.isDegraded()) {
      const AUTOMATED_EXECUTION_COMMANDS = new Set([
        'PLACE_BET',
        'CASH_OUT',
        'START_AUTOMATION',
        'VALIDATE',
        'ACTIVATE_ACCOUNT',
        'DEACTIVATE_ACCOUNT',
        'TEST_DEGRADED_BET'
      ]);
      if (AUTOMATED_EXECUTION_COMMANDS.has(commandType)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Irreversibly revokes the current license and locks down execution (CAN-09 / DEF-09).
   * Immediately sets the native FFI revocation flag to fail-closed,
   * severs active CDP proxies, closes secure IPC pipes, and persists the REVOKED state.
   * @param {string} [reason]
   * @returns {Promise<boolean>}
   */
  async revokeLicense(reason = 'BACKEND_REVOCATION') {
    // 1. Immediately assert native FFI revocation kill-switch hot-path (< 50ms)
    NativeCore.setRevokedSync(true);

    // 2. Dispatch state machine transition to REVOKED
    try {
      await engineInstance.dispatch(TransitionEvent.BACKEND_REVOCATION, {
        nonceChecked: true,
        reason
      });
    } catch {
      // Continue fail-closed lockdown even if state machine transition errors
    }

    // 3. Ensure in-memory state and persistent state are set to REVOKED (survives restart)
    if (engineInstance.inMemoryState) {
      engineInstance.inMemoryState.state = SecurityState.REVOKED;
      engineInstance.inMemoryState.license = {
        status: 'REVOKED',
        revokedAt: Date.now(),
        reason
      };
      try {
        const row = await StorageAdapter.getSecurityStateRow();
        if (row && row.state !== SecurityState.REVOKED) {
          await StorageAdapter.commitTransitionWithOCC(
            row.state_version,
            engineInstance.inMemoryState,
            TransitionEvent.BACKEND_REVOCATION
          );
        }
      } catch { /* storage fallback */ }
    }

    // 4. Forcefully sever all active CDP proxy connections immediately
    try {
      SecureCdpProxy.closeAll();
    } catch {}

    // 5. Forcefully stop secure IPC server
    try {
      NativeCore.stopSecurePipeServer();
    } catch {}

    // 6. Log audit event
    try {
      await this.logAuditEvent('LICENSE_REVOKED', 'CRITICAL', { reason });
    } catch {}

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
