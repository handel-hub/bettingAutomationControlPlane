// @ts-check
import { securityFacade } from '../security-authority/facade.mjs';
import { SecurityState } from '../security-authority/state-machine/states.mjs';

/**
 * Single authoritative mapper from SecurityFacade + Billing state to Frontend AppLifecycleState.
 *
 * Canonical states:
 * - 'Initializing'
 * - 'Authentication_Required'
 * - 'Payment_Required'
 * - 'Authorized'
 * - 'Revoked'
 * - 'Offline_Fatal'
 *
 * @param {object} [options]
 * @param {any} [options.billingSnapshot]
 * @returns {'Initializing' | 'Authentication_Required' | 'Payment_Required' | 'Authorized' | 'Revoked' | 'Offline_Fatal'}
 */
export function resolveAuthoritativeLifecycleState(options = {}) {
  const securityState = securityFacade.getSystemState();
  const licenseInfo = securityFacade.getLicenseInfo();
  const billingSnapshot = options.billingSnapshot || null;

  if (securityState === 'UNINITIALIZED' || securityState === SecurityState.UNINITIALIZED || securityState === SecurityState.INITIALIZING) {
    return 'Initializing';
  }

  if (
    securityState === SecurityState.REVOKED ||
    securityState === SecurityState.COMPROMISED ||
    licenseInfo?.status === 'REVOKED'
  ) {
    return 'Revoked';
  }

  if (
    securityState === SecurityState.SECURITY_STATE_UNCERTAIN ||
    securityState === SecurityState.INTEGRITY_DEGRADED ||
    securityState === SecurityState.TAMPER_SUSPECTED
  ) {
    return 'Offline_Fatal';
  }

  if (
    securityState === SecurityState.OPERATIONAL ||
    securityState === SecurityState.OFFLINE_GRACE ||
    securityState === SecurityState.RENEWING
  ) {
    if (
      billingSnapshot?.status === 'Past_Due' ||
      (billingSnapshot?.status === 'Payment_Required' && licenseInfo?.status !== 'VALID')
    ) {
      return 'Payment_Required';
    }
    return 'Authorized';
  }

  if (
    securityState === SecurityState.AUTHENTICATED ||
    securityState === SecurityState.AUTHZ_FAILURE ||
    securityState === SecurityState.EXPIRED
  ) {
    return 'Payment_Required';
  }

  if (
    securityState === SecurityState.UNAUTHENTICATED ||
    securityState === SecurityState.SECURITY_STATE_READY ||
    securityState === SecurityState.AUTHENTICATING ||
    securityState === SecurityState.AUTH_FAILED ||
    securityState === SecurityState.LOGGED_OUT ||
    securityState === SecurityState.LOGGING_OUT ||
    securityState === SecurityState.REAUTHENTICATION_REQUIRED
  ) {
    return 'Authentication_Required';
  }

  return 'Offline_Fatal';
}
