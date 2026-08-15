// @ts-check

/**
 * @typedef {Object} MachineDescriptor
 * @property {string} hardwareId - Derived from TPM or stable hardware characteristics
 * @property {string} machineKeyPub - Ed25519 public key bound to this machine
 * @property {string} generation - Opaque string tracking machine revocation state
 */

/**
 * @typedef {Object} UserDescriptor
 * @property {string} userId - Canonical user identifier
 * @property {string} authProvider - Source of truth (e.g. 'OIDC', 'Local')
 */
