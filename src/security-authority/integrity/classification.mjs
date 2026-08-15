// @ts-check

/**
 * @typedef {"SYSTEM" | "STRATEGY" | "PLUGIN" | "DATA"} AssetClass
 */

/**
 * Defines classification profiles for control plane assets.
 */
export const ASSET_CLASSIFICATIONS = {
  SYSTEM: {
    requiresSignature: true,
    allowDynamicLoad: false,
    isolationLevel: "HIGH"
  },
  STRATEGY: {
    requiresSignature: true,
    allowDynamicLoad: true,
    isolationLevel: "SANDBOX"
  },
  PLUGIN: {
    requiresSignature: true,
    allowDynamicLoad: true,
    isolationLevel: "SANDBOX"
  },
  DATA: {
    requiresSignature: false,
    allowDynamicLoad: true,
    isolationLevel: "NONE"
  }
};
