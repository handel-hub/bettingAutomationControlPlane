// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SanitizerGate } from '../../../src/state-store/validation/SanitizerGate.mjs';
import { SecurityViolationError } from '../../../src/state-store/types/errors.mjs';

describe('SanitizerGate Unit Tests', () => {
  it('strips accountPassword and replaces with [PROTECTED]', () => {
    const raw = {
      id: 'acc-1',
      accountUsername: 'john_doe',
      accountPassword: 'PlaintextSuperSecretPassword123!'
    };
    const sanitized = SanitizerGate.sanitize(raw);
    assert.equal(sanitized.accountPassword, '[PROTECTED]');
    assert.notEqual(sanitized.accountPassword, 'PlaintextSuperSecretPassword123!');
  });

  it('strips sensitive payment and session keys completely', () => {
    const raw = {
      userId: 'usr_1',
      sessionToken: 'jwt-header.payload.signature',
      cardToken: 'flw_card_token_secret',
      cvv: '123',
      proxyAuth: 'user:pass',
      safeData: 'hello'
    };
    const sanitized = SanitizerGate.sanitize(raw);
    assert.equal(sanitized.safeData, 'hello');
    assert.equal(sanitized.sessionToken, undefined);
    assert.equal(sanitized.cardToken, undefined);
    assert.equal(sanitized.cvv, undefined);
    assert.equal(sanitized.proxyAuth, undefined);
  });

  it('throws SecurityViolationError when assertZeroSecrets detects prohibited keys', () => {
    const tainted = {
      id: 'acc-1',
      accountPassword: 'secretPassword'
    };
    assert.throws(() => {
      SanitizerGate.assertZeroSecrets(tainted);
    }, SecurityViolationError);
  });

  it('does not mutate original object', () => {
    const original = { id: 'acc-1', accountPassword: 'pw' };
    const clean = SanitizerGate.sanitize(original);
    assert.equal(original.accountPassword, 'pw');
    assert.equal(clean.accountPassword, '[PROTECTED]');
  });
});
