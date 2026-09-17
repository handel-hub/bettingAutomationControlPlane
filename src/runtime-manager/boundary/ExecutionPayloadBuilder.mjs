// @ts-check
import { vaultCredentialPipeline } from './VaultCredentialPipeline.mjs';

/**
 * ExecutionPayloadBuilder
 * 
 * Compiles full-document PascalCase configuration schemas and initialization payloads
 * conforming to the Execution Plane's AutomationController and MemoryPolicyProvider expectations.
 */
export class ExecutionPayloadBuilder {
  /**
   * Compiles the PascalCase Policy object for an account from ACP config.
   * @param {object} globalConfig
   * @param {object} [accountOverrides]
   * @returns {object}
   */
  static buildPolicyDocument(globalConfig, accountOverrides = {}) {
    const pricing = globalConfig?.pricing || {};
    const risk = globalConfig?.risk || {};
    const rebet = globalConfig?.rebet || {};
    const execution = globalConfig?.execution || {};

    const customPricing = accountOverrides?.customPricing || {};
    const customRisk = accountOverrides?.customRisk || {};
    const customRebet = accountOverrides?.customRebet || {};

    return {
      BetCycle: {
        Execution: {
          Enabled: accountOverrides.betCycleEnabled !== false,
          Description: "Gate flag dictating whether this account is authorized to execute physical bet submission cycles"
        }
      },
      Pricing: {
        Strategy: {
          Mode: customPricing.mode || pricing.mode || 'PROFIT_TARGET',
          BaseStake: Number(customPricing.baseStake ?? pricing.baseStake ?? 100),
          TargetProfit: Number(customPricing.targetProfit ?? pricing.targetProfit ?? 30),
          MinimumAcceptableProfit: Number(customPricing.minimumAcceptableProfit ?? pricing.minimumAcceptableProfit ?? 0),
          ResolutionStrategy: customPricing.resolutionStrategy || pricing.resolutionStrategy || 'CLAMP_THEN_REDUCE_PROFIT'
        },
        Behavior: {
          PlatformIncrement: Number(pricing.platformIncrement ?? 1),
          SelectionPreference: pricing.selectionPreference || 'ROUND_NUMBERS',
          RestorePolicyOnRebet: pricing.restorePolicyOnRebet !== false
        }
      },
      Rebet: {
        Strategy: {
          MaxRebetAttempts: Number(customRebet.maxRebetAttempts ?? rebet.maxRebetAttempts ?? 1),
          RebetStakeIncrement: Number(customRebet.rebetStakeIncrement ?? rebet.rebetStakeIncrement ?? 10)
        }
      },
      Execution: {
        Timeouts: {
          ResultTimeoutMs: Number(execution.orderTimeoutMs || 30000),
          NavigationTimeoutMs: Number(execution.navigationTimeoutMs || 10000),
          LoginTimeoutMs: Number(execution.loginTimeoutMs || 15000),
          DecisionFreshnessTTLMs: Number(execution.decisionFreshnessTTLMs || 3000),
          ReconciliationTimeoutMs: Number(execution.reconciliationTimeoutMs || 120000)
        },
        Pacing: {
          KeyboardTypingDelayMs: Number(execution.interPlatformDelayMs || 250),
          PacingStrategy: execution.pacingStrategy || 'AGGRESSIVE'
        }
      },
      RiskManagement: {
        Policy: {
          MaxStake: Number(customRisk.maxStake ?? risk.maxStake ?? risk.stopLossThreshold ?? 10000),
          MinimumStake: Number(customRisk.minimumStake ?? risk.minimumStake ?? 10),
          AutoAcceptOddsChanges: Boolean(risk.autoAcceptOddsChanges)
        },
        Limits: {
          MaxStake: Number(customRisk.maxStake ?? risk.maxStake ?? risk.stopLossThreshold ?? 10000),
          MinimumStake: Number(customRisk.minimumStake ?? risk.minimumStake ?? 10),
          AutoAcceptOddsChanges: Boolean(risk.autoAcceptOddsChanges)
        }
      }
    };
  }

  /**
   * Compiles the complete LIFECYCLE:INITIALIZE payload conforming to Execution Plane's AutomationController constructor.
   * Merges decrypted credentials from VaultCredentialPipeline into temporary in-memory objects.
   * 
   * @param {object} store - StateStore instance
   * @param {string} [traceId]
   * @returns {object}
   */
  static buildInitializationPayload(store, traceId = undefined) {
    const globalConfig = typeof store.configContainer?.getGlobalConfig === 'function'
      ? store.configContainer.getGlobalConfig()
      : (typeof store.configContainer?.toSettingsIniObject === 'function'
        ? store.configContainer.toSettingsIniObject()
        : {});
    const accounts = typeof store.accountsContainer?.getAll === 'function'
      ? store.accountsContainer.getAll()
      : [];

    // 1. Compile INI-compatible Settings for AutomationController
    const settings = {
      Spawning: {
        max_accounts_to_spawn: String(globalConfig.browserSpawning?.maxAccountsToSpawn || 2),
        slave_mode: globalConfig.browserSpawning?.slaveMode || 'headful',
        spawn_stagger_interval_ms: String(globalConfig.browserSpawning?.spawnStaggerIntervalMs || 1200)
      },
      Proxy: {
        proxy_allocation_mode: globalConfig.proxy?.proxyAllocationMode || 'round_robin',
        proxy_failure_mode: globalConfig.proxy?.proxyFailureMode || 'loose',
        max_accounts_per_proxy: String(globalConfig.proxy?.maxAccountsPerProxy || 3)
      },
      Stealth: {
        browser_binary: globalConfig.advancedRuntime?.browserBinary || 'chrome',
        use_stealth_plugin: Boolean(globalConfig.advancedRuntime?.useStealthPlugin)
      }
    };

    // 2. Decrypt credentials on-demand right before IPC handoff
    const compiledAccounts = accounts.map((acc, index) => {
      const decryptedPassword = acc.accountPassword && acc.accountPassword !== '[PROTECTED]'
        ? acc.accountPassword
        : (acc.rawPassword || vaultCredentialPipeline.decryptCredential(acc.id, acc.rawPassword || acc.accountPassword));
      return {
        id: acc.id,
        role: index === 0 ? 'master' : 'slave',
        platformId: (acc.platformId || acc.platformDisplayName || 'sportybet').toLowerCase(),
        username: acc.accountUsername,
        password: decryptedPassword,
        proxyUrl: acc.proxyUrl || null
      };
    });

    // 3. Compile full-document initial policies for all provisioned accounts
    const accountPolicies = {};
    for (const acc of accounts) {
      const overrides = typeof store.configContainer?.getAccountOverride === 'function'
        ? store.configContainer.getAccountOverride(acc.id)
        : {};
      const policyDoc = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig, overrides);
      accountPolicies[acc.accountUsername] = policyDoc;
      if (acc.id) {
        accountPolicies[acc.id] = policyDoc;
      }
    }

    const defaultPolicy = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig);
    const config = typeof store.configContainer?.toSettingsIniObject === 'function'
      ? store.configContainer.toSettingsIniObject()
      : {};

    return {
      protocolVersion: '3.0',
      settings,
      accounts: compiledAccounts,
      proxies: [],
      policy: {
        defaultPolicy,
        accountPolicies
      },
      fleet: {
        accounts: compiledAccounts.map(a => ({
          ...a,
          accountId: a.id,
          role: a.role,
          username: a.username,
          password: a.password
        }))
      },
      configuration: {
        pricing: config.Pricing || { mode: 'PROFIT_TARGET', baseStake: 100, targetProfit: 25 },
        risk: config.Risk || { maxStake: 5000 }
      }
    };
  }

  /**
   * Compiles the payload for ACTIVATE_ACCOUNT command with decrypted credentials and active policy.
   * @param {object} account
   * @param {object} [store]
   * @returns {object}
   */
  static buildActivateAccountPayload(account, store = null) {
    const decryptedPassword = account.accountPassword && account.accountPassword !== '[PROTECTED]'
      ? account.accountPassword
      : (account.rawPassword || vaultCredentialPipeline.decryptCredential(account.id, account.rawPassword || account.accountPassword));

    let policy = null;
    if (store && typeof store.configContainer?.getGlobalConfig === 'function') {
      const globalConfig = store.configContainer.getGlobalConfig();
      const overrides = typeof store.configContainer?.getAccountOverride === 'function'
        ? store.configContainer.getAccountOverride(account.id)
        : {};
      policy = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig, overrides);
    }

    const payload = {
      accountId: account.id,
      account: {
        id: account.id,
        username: account.accountUsername || account.username,
        password: decryptedPassword,
        platformId: (account.platformId || account.platformDisplayName || 'sportybet').toLowerCase()
      },
      proxyUrl: account.proxyUrl || null
    };

    if (policy) {
      payload.policy = policy;
      payload.account.policy = policy;
    }

    return payload;
  }
}
