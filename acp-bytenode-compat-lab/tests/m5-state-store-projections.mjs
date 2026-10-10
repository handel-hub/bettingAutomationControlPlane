// acp-bytenode-compat-lab/tests/m5-state-store-projections.mjs
// M5: StateStore in-memory containers & projection generation compatibility tests

import { StateStore } from '../../src/state-store/StateStore.mjs';
import { AccountsContainer } from '../../src/state-store/memory/AccountsContainer.mjs';
import { SanitizerGate, sanitizeAccountForExport } from '../../src/state-store/validation/SanitizerGate.mjs';
import { RevisionConflictError } from '../../src/state-store/types/errors.mjs';

export function registerM5Tests(harness) {
  harness.test('M5-001', 'AccountsContainer OCC revision increment & duplicate prevention', 'M5-StateStore', async () => {
    const container = new AccountsContainer();
    const acc = {
      id: 'acc_test_1',
      platform: 'SportyBet',
      platformDisplayName: 'SportyBet NG',
      accountUsername: 'test_trader',
      accountPassword: 'secret_password_123',
      stagingState: 'STAGED',
      backendState: 'ACTIVE',
    };

    container.upsert(acc);
    const rev1 = container.revision;
    const stored = container.getById('acc_test_1');

    if (!stored || stored.accountUsername !== 'test_trader' || rev1 !== 2) {
      throw new Error(`AccountsContainer initial upsert failed: stored=${JSON.stringify(stored)}, rev=${rev1}`);
    }

    // OCC conflict test
    let occThrew = false;
    try {
      container.upsert({ ...stored, balance: 100 }, 999); // Stale revision
    } catch (err) {
      if (err instanceof RevisionConflictError) occThrew = true;
    }

    if (!occThrew) {
      throw new Error('Expected RevisionConflictError on stale revision');
    }

    return { upsertOk: true, revision: rev1, occVerified: true };
  });

  harness.test('M5-002', 'SanitizerGate secret redaction immutability', 'M5-StateStore', async () => {
    const rawAccount = {
      id: 'acc_sec_1',
      accountUsername: 'trader_x',
      accountPassword: 'super_secret_plain_password',
      secretKey: 'secret_api_key',
    };

    const sanitized = sanitizeAccountForExport(rawAccount);

    if (rawAccount.accountPassword !== 'super_secret_plain_password') {
      throw new Error('SanitizerGate mutated input object!');
    }
    if (sanitized.accountPassword !== '[PROTECTED]' || sanitized.secretKey !== undefined) {
      throw new Error(`SanitizerGate failed to protect secrets: ${JSON.stringify(sanitized)}`);
    }

    return { redacted: true, protectedValue: sanitized.accountPassword };
  });

  harness.test('M5-003', 'StateStore full in-memory lifecycle & Prelude projection', 'M5-StateStore', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_compat_lab' });
    store.initialize();

    store.accounts.upsert({
      id: 'acc_lab_01',
      platformDisplayName: 'SportyBet NG',
      accountUsername: 'compat_trader',
      accountPassword: 'plain_password_abc',
      stagingState: 'STAGED',
      backendState: 'ACTIVE',
    });

    const prelude = store.getPreludeSnapshot();

    const accounts = prelude?.payload?.accounts?.initialView?.viewportAccounts;
    if (!accounts || !Array.isArray(accounts)) {
      throw new Error('Prelude projection missing accounts.initialView.viewportAccounts array');
    }

    const projectedAccount = accounts.find(a => a.id === 'acc_lab_01');
    if (!projectedAccount) {
      throw new Error('Account missing from projected prelude snapshot');
    }

    if (projectedAccount.accountPassword === 'plain_password_abc') {
      throw new Error('CRITICAL: Plaintext password leaked into Prelude projection!');
    }

    store.close();
    return {
      protocol: prelude.payload.protocol,
      accountPresent: true,
      passwordSafelyRedacted: projectedAccount.accountPassword === '[PROTECTED]',
    };
  });
}
