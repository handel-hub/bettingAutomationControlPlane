// @ts-check

export class ContractViolationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContractViolationError';
    this.code = 'LF-701';
    this.details = details;
  }
}

const VALID_CATEGORIES = new Set(['Execution', 'Persistence', 'Security', 'Billing', 'System']);

export class CommandPayloadSchema {
  /**
   * Validates a normalized or incoming Command object.
   * @param {any} cmd
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validate(cmd) {
    const errors = [];

    if (!cmd || typeof cmd !== 'object') {
      return { valid: false, errors: ['Command must be a non-null object'] };
    }

    if (!cmd.id && !cmd.commandId) {
      errors.push('Missing unique command identifier (id or commandId)');
    }

    if (!cmd.category || !VALID_CATEGORIES.has(cmd.category)) {
      errors.push(`Invalid or missing category [${cmd.category}]. Must be one of: ${Array.from(VALID_CATEGORIES).join(', ')}`);
    }

    if (!cmd.type || typeof cmd.type !== 'string') {
      errors.push('Missing or invalid command type (must be a non-empty string)');
    }

    // Per-command payload constraints
    const payload = cmd.payload || {};
    switch (cmd.type) {
      case 'PLACE_BET':
        if (payload.stake !== undefined && (typeof payload.stake !== 'number' || payload.stake < 0)) {
          errors.push('PLACE_BET payload.stake must be a positive number');
        }
        if (payload.odds !== undefined && (typeof payload.odds !== 'number' || payload.odds <= 1.0)) {
          errors.push('PLACE_BET payload.odds must be a number > 1.0');
        }
        break;

      case 'TOGGLE_BET_CYCLE':
        if (typeof payload.enabled !== 'boolean') {
          errors.push('TOGGLE_BET_CYCLE payload.enabled must be a boolean');
        }
        break;

      case 'ACTIVATE_ACCOUNT':
        if (!payload.accountUsername && !payload.id && !cmd.target) {
          errors.push('ACTIVATE_ACCOUNT requires accountUsername or target id');
        }
        break;

      case 'DEACTIVATE_ACCOUNT':
        if (!cmd.target && !payload.id && !payload.accountId) {
          errors.push('DEACTIVATE_ACCOUNT requires target account identifier');
        }
        break;

      case 'SETTINGS_INTENT':
        if (!payload.type) {
          errors.push('SETTINGS_INTENT requires payload.type');
        }
        break;

      case 'BULK_ACTION':
        if (!payload.type || !Array.isArray(payload.accountIds)) {
          errors.push('BULK_ACTION requires payload.type and array of payload.accountIds');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
