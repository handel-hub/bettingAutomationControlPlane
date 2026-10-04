// @ts-check
import { NativeCore } from '../../security-authority/native/security-core.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';

/**
 * VaultCredentialPipeline
 * 
 * Manages in-memory credential storage and delegation to the SQLite StateStore.
 */
export class VaultCredentialPipeline {
  /**
   * @param {object} [options]
   * @param {typeof NativeCore} [options.nativeCore]
   */
  constructor(options = {}) {
    this.native = options.nativeCore || NativeCore;
    /** @type {Map<string, { plaintext?: string, encryptedPassword?: Buffer, updatedAt: string }>} */
    this._vault = new Map();
  }

  /**
   * Stores a credential into memory vault.
   * @param {string} accountId
   * @param {string} plaintextPassword
   */
  storeCredential(accountId, plaintextPassword) {
    if (!accountId || typeof accountId !== 'string') {
      return;
    }
    if (!plaintextPassword || typeof plaintextPassword !== 'string') {
      return;
    }
    const isMasked = (pwd) => !pwd || pwd === '[PROTECTED]' || pwd.includes('***') || pwd.includes('???') || pwd.includes('•••');
    if (isMasked(plaintextPassword)) {
      return;
    }

    this._vault.set(accountId, {
      plaintext: plaintextPassword,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Retrieves password for account on-demand.
   * Returns plaintext string for immediate IPC dispatch.
   * @param {string} accountId
   * @param {string} [fallbackPassword]
   * @returns {string}
   */
  decryptCredential(accountId, fallbackPassword = null) {
    const isMasked = (pwd) => !pwd || pwd === '[PROTECTED]' || pwd.includes('***') || pwd.includes('???') || pwd.includes('•••');

    const entry = this._vault.get(accountId);
    if (entry && entry.plaintext && !isMasked(entry.plaintext)) {
      return entry.plaintext;
    }
    if (entry && entry.encryptedPassword) {
      try {
        const aad = Buffer.from(`ACP_VAULT_${accountId}`, 'utf8');
        const decryptedBuf = this.native.decryptAead(entry.encryptedPassword, aad);
        const plaintext = decryptedBuf.toString('utf8');
        decryptedBuf.fill(0);
        if (plaintext && !isMasked(plaintext)) {
          entry.plaintext = plaintext;
          return plaintext;
        }
      } catch { /* ignore */ }
    }

    // Check authoritative SQLite State Store directly via getRawPassword
    try {
      const store = getSharedStateStore();
      const rawPassword = store.accounts.getRawPassword(accountId);
      if (rawPassword && !isMasked(rawPassword)) {
        this.storeCredential(accountId, rawPassword);
        return rawPassword;
      }
      // Also check memory container as second fallback
      const account = store.accounts.getById(accountId);
      if (account && account.accountPassword && !isMasked(account.accountPassword)) {
        this.storeCredential(accountId, account.accountPassword);
        return account.accountPassword;
      }
    } catch { /* ignore */ }

    if (fallbackPassword && !isMasked(fallbackPassword)) {
      this.storeCredential(accountId, fallbackPassword);
      return fallbackPassword;
    }
    return '';
  }

  /**
   * Removes credentials from memory vault.
   * @param {string} accountId
   */
  evictCredential(accountId) {
    const entry = this._vault.get(accountId);
    if (entry) {
      if (entry.encryptedPassword) entry.encryptedPassword.fill(0);
      this._vault.delete(accountId);
    }
  }

  /**
   * Checks if an account has encrypted credentials provisioned in vault.
   * @param {string} accountId
   */
  hasCredential(accountId) {
    return this._vault.has(accountId);
  }

  /**
   * Clears the entire vault (e.g. on user logout).
   */
  clear() {
    for (const entry of this._vault.values()) {
      entry.encryptedPassword.fill(0);
    }
    this._vault.clear();
  }
}

export const vaultCredentialPipeline = new VaultCredentialPipeline();
