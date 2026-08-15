// @ts-check

/**
 * @typedef {Object} MachineIdentityRow
 * @property {string|null} machine_id null until Backend registration
 * @property {string} installation_id generated locally, always present
 * @property {number} identity_version
 * @property {MachineIdentityStatus} status
 * @property {string} created_at ISO-8601 UTC
 * @property {string|null} last_registered_at
 * @property {string|null} last_verified_at
 * @property {string} key_reference opaque handle into native keystore, NEVER raw key material
 * @property {string|null} backend_binding_id
 * @property {number} machine_generation one of the five generation counters
 * @property {string} created_by_version
 * @property {string} updated_at
 */

/**
 * @typedef {"UNINITIALIZED" | "GENERATING" | "CREATED" | "REGISTERED" | "VERIFIED" | "CORRUPTED" | "REPLACEMENT_REQUIRED" | "RE_VERIFICATION_REQUIRED" | "REVOKED"} MachineIdentityStatus
 */

/**
 * @typedef {Object} SessionRow
 * @property {string} session_id
 * @property {SessionStatus} status
 * @property {string} issued_at
 * @property {string} expires_at
 * @property {string} renew_after
 * @property {string|null} last_renewed_at
 * @property {string|null} last_verified_at
 * @property {string} authentication_method
 * @property {string|null} authorization_snapshot_id
 * @property {number} server_key_version
 * @property {number} session_protocol_version
 * @property {number} session_generation
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {"NO_SESSION" | "AUTHENTICATING" | "AUTHENTICATED" | "RENEWING" | "DEGRADED" | "EXPIRED" | "REVOKED" | "LOGGING_OUT" | "LOGGED_OUT" | "INVALID"} SessionStatus
 */

/**
 * @typedef {Object} AuthorizationRow
 * @property {string} authorization_id
 * @property {string} session_id
 * @property {string} user_id
 * @property {string} machine_id
 * @property {"VALID" | "EXPIRED" | "REVOKED" | "SUPERSEDED"} status
 * @property {string} issued_at
 * @property {string} effective_at
 * @property {string} expires_at
 * @property {number} authorization_revision
 * @property {number} backend_revision
 * @property {string} license_id
 * @property {string[]} capability_set JSON array of CAP_* strings
 * @property {number} policy_version
 * @property {string} last_verified_at
 */

/**
 * @typedef {Object} LicenseRow
 * @property {string} license_id
 * @property {string} account_id
 * @property {string} machine_binding
 * @property {string} plan_id
 * @property {"UNKNOWN" | "VALID" | "EXPIRING" | "EXPIRED" | "REVOKED" | "SUSPENDED" | "INVALID"} status
 * @property {string} issued_at
 * @property {string} effective_at
 * @property {string|null} expires_at
 * @property {string|null} revoked_at
 * @property {number} license_revision
 * @property {string[]} capabilities
 * @property {Record<string, number>} limits
 * @property {number} backend_revision
 * @property {string} last_verified_at
 */

/**
 * @typedef {Object} SecurityStateRow
 * @property {number} state_version OCC token
 * @property {string} security_state SecurityState enum
 * @property {number} session_generation
 * @property {number} authorization_revision
 * @property {number} license_revision
 * @property {number} machine_generation
 * @property {number} server_trust_version
 * @property {"hardware" | "os_keychain" | "software_encrypted"} key_storage_tier
 * @property {number} offline_grace_accumulated_ms
 * @property {string|null} offline_grace_last_contact_wallclock
 * @property {string} last_transition
 * @property {string} last_transition_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} PendingTransactionRow
 * @property {string} transaction_id
 * @property {string} operation_type
 * @property {"CREATED" | "SENT" | "RESPONSE_PENDING" | "COMMITTED" | "RETRY_PENDING" | "FAILED"} state
 * @property {string} request_nonce
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} SecurityEventRow
 * @property {string} event_id
 * @property {string} event_type
 * @property {"INFO" | "WARN" | "SIGNIFICANT" | "CRITICAL"} severity
 * @property {string} timestamp
 * @property {number|null} session_generation
 * @property {number|null} machine_generation
 * @property {number|null} authorization_revision
 * @property {string|null} transaction_id
 * @property {string} result
 * @property {Record<string, unknown>} metadata
 * @property {string|null} prev_event_hash
 * @property {string} event_hash
 */

export {};
