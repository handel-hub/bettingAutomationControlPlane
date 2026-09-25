// @ts-check
import { ValidationError } from '../types/errors.mjs';

/**
 * Structural payload validators for State Store operations.
 */
export class PayloadValidators {
  /**
   * Validates account creation / upsert data.
   * @param {any} data
   */
  static validateAccount(data) {
    if (!data || typeof data !== 'object') {
      throw new ValidationError('Account payload must be a non-null object');
    }
    if (!data.id || typeof data.id !== 'string') {
      throw new ValidationError('Account payload requires a string `id`');
    }
    if (!data.platformDisplayName && !data.platformId) {
      throw new ValidationError('Account requires `platformDisplayName` or `platformId`');
    }
    if (!data.accountUsername || typeof data.accountUsername !== 'string') {
      throw new ValidationError('Account requires a string `accountUsername`');
    }
  }

  /**
   * Validates global automation configuration.
   * @param {any} config
   */
  static validateGlobalConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new ValidationError('Global config payload must be a non-null object');
    }
    const requiredCategories = ['pricing', 'risk', 'rebet', 'proxy', 'execution', 'browserSpawning', 'advancedRuntime'];
    for (const cat of requiredCategories) {
      if (!config[cat] || typeof config[cat] !== 'object') {
        throw new ValidationError(`Global config is missing required category: [${cat}]`);
      }
    }
  }

  /**
   * Validates a single configuration category.
   * @param {string} category
   * @param {any} values
   */
  static validateCategoryValues(category, values) {
    const validCategories = new Set(['pricing', 'risk', 'rebet', 'proxy', 'execution', 'browserSpawning', 'advancedRuntime']);
    if (!validCategories.has(category)) {
      throw new ValidationError(`Unknown configuration category: [${category}]`);
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new ValidationError(`Values for category [${category}] must be a non-null object`);
    }
  }

  /**
   * Validates subscription snapshot data.
   * @param {any} sub
   */
  static validateSubscription(sub) {
    if (!sub || typeof sub !== 'object') {
      throw new ValidationError('Subscription snapshot must be a non-null object');
    }
    if (!sub.status || typeof sub.status !== 'string') {
      throw new ValidationError('Subscription requires a valid string `status`');
    }
    if (!sub.planId && !sub.currentPlanId && !sub.plan_id) {
      throw new ValidationError('Subscription requires a `planId`');
    }
  }
}
