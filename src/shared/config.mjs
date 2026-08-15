// @ts-check

/**
 * Standardized configuration loader for the Control Plane.
 */
export const Config = {
  get(key, defaultValue = null) {
    return process.env[key] ?? defaultValue;
  },
  
  require(key) {
    const val = process.env[key];
    if (val === undefined) throw new Error(`Missing required config: ${key}`);
    return val;
  }
};
