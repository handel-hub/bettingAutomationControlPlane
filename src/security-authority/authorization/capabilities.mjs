// @ts-check

/**
 * @typedef {typeof CAPABILITY[keyof typeof CAPABILITY]} Capability
 */

/**
 * Canonical 7 Capabilities strictly enforced by the CP.
 * The Backend decides entitlement; the CP caches and enforces these flags 
 * synchronously against the Execution Plane.
 */
export const CAPABILITY = /** @type {const} */ ({
  AUTOMATION_START: "CAP_AUTOMATION_START",
  AUTOMATION_STOP: "CAP_AUTOMATION_STOP",
  BROWSER_ALLOCATE: "CAP_BROWSER_ALLOCATE",
  FILE_UPLOAD: "CAP_FILE_UPLOAD",
  FILE_DOWNLOAD: "CAP_FILE_DOWNLOAD",
  CONFIG_MODIFY: "CAP_CONFIG_MODIFY",
  UPDATE_INSTALL: "CAP_UPDATE_INSTALL"
});
