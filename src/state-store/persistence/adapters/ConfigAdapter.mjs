// @ts-check
import { SanitizerGate } from '../../validation/SanitizerGate.mjs';
import { createDefaultGlobalConfig } from '../../types/contracts.mjs';

/**
 * Persistence adapter for global_automation_config.
 */
export class ConfigAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Loads global config for a user. Returns default if not found.
   * @param {string} userId
   * @returns {any}
   */
  get(userId) {
    const row = this.engine.prepare(`
      SELECT pricing_json AS pricingJson, risk_json AS riskJson, rebet_json AS rebetJson,
             proxy_json AS proxyJson, execution_json AS executionJson, spawning_json AS spawningJson,
             runtime_json AS runtimeJson, updated_at AS updatedAt
      FROM global_automation_config
      WHERE user_id = ?
    `).get(userId);

    if (!row) {
      return createDefaultGlobalConfig();
    }

    return {
      pricing: JSON.parse(row.pricingJson),
      risk: JSON.parse(row.riskJson),
      rebet: JSON.parse(row.rebetJson),
      proxy: JSON.parse(row.proxyJson),
      execution: JSON.parse(row.executionJson),
      browserSpawning: JSON.parse(row.spawningJson),
      advancedRuntime: JSON.parse(row.runtimeJson)
    };
  }

  /**
   * Saves complete global config for a user.
   * @param {string} userId
   * @param {any} config
   */
  save(userId, config) {
    SanitizerGate.assertZeroSecrets(config);
    const now = new Date().toISOString();
    const configId = `cfg_${userId}`;

    this.engine.prepare(`
      INSERT INTO global_automation_config (
        config_id, user_id, pricing_json, risk_json, rebet_json,
        proxy_json, execution_json, spawning_json, runtime_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET
        pricing_json = excluded.pricing_json,
        risk_json = excluded.risk_json,
        rebet_json = excluded.rebet_json,
        proxy_json = excluded.proxy_json,
        execution_json = excluded.execution_json,
        spawning_json = excluded.spawning_json,
        runtime_json = excluded.runtime_json,
        updated_at = excluded.updated_at
    `).run(
      configId,
      userId,
      JSON.stringify(config.pricing),
      JSON.stringify(config.risk),
      JSON.stringify(config.rebet),
      JSON.stringify(config.proxy),
      JSON.stringify(config.execution),
      JSON.stringify(config.browserSpawning),
      JSON.stringify(config.advancedRuntime),
      now
    );
  }

  /**
   * Deletes global config for a user (logout purge).
   * @param {string} userId
   */
  deleteForUser(userId) {
    this.engine.prepare('DELETE FROM global_automation_config WHERE user_id = ?').run(userId);
  }
}
