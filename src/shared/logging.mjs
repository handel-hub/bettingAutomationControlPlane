// @ts-check

/**
 * Standardized local logging facade.
 * Sensitive data MUST be redacted before being passed here.
 */
export const Logger = {
  /**
   * @param {string} context 
   * @param {string} message 
   * @param {any} [meta] 
   */
  info(context, message, meta) {
    console.log(`[INFO] [${context}] ${message}`, meta ? JSON.stringify(meta) : '');
  },

  /**
   * @param {string} context 
   * @param {string} message 
   * @param {any} [error] 
   */
  error(context, message, error) {
    console.error(`[ERROR] [${context}] ${message}`, error);
  },

  /**
   * @param {string} context 
   * @param {string} message 
   */
  warn(context, message) {
    console.warn(`[WARN] [${context}] ${message}`);
  }
};
