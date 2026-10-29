// @ts-check
import crypto from 'crypto';
import { NativeCore } from '../../security-authority/native/security-core.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';

/**
 * VaultCredentialPipeline
 * 
 * Manages in-memory AEAD-encrypted credential storage and delegation to the SQLite StateStore.
 * Plaintext strings are never retained in `_vault`; credentials are encrypted at rest in memory
 * and decrypted on demand only for immediate IPC dispatch.
 */
export class VaultCredentialPipeline {
  /**
   * @param {object} [options]
   * @param {typeof NativeCore} [options.nativeCore]
   */
  constructor(options = {}) {
    this.native = options.nativeCore || NativeCore;
    this._ephemeralKey = crypto.randomBytes(32);
    /** @type {Map<string, { encryptedPassword: Buffer, iv?: Buffer, authTag?: Buffer, mode: 'native' | 'node', updatedAt: string }>} */
    this._vault = new Map();
  }

  /**
   * Stores a credential into memory vault using AEAD encryption.
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

    // Zeroize any previous buffer for this account before overwriting
    this.evictCredential(accountId);

    const aad = Buffer.from(`ACP_VAULT_${accountId}`, 'utf8');
    const plainBuf = Buffer.from(plaintextPassword, 'utf8');
    try {
      const encryptedPassword = Buffer.from(this.native.encryptAead(plainBuf, aad));
      plainBuf.fill(0);
      this._vault.set(accountId, {
        encryptedPassword,
        mode: 'native',
        updatedAt: new Date().toISOString()
      });
      return;
    } catch {
      // Fallback to ephemeral in-process AES-256-GCM when native storage root is not initialized in unit tests
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this._ephemeralKey, iv);
      cipher.setAAD(aad);
      const encryptedPassword = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
      const authTag = cipher.getAuthTag();
      plainBuf.fill(0);
      this._vault.set(accountId, {
        encryptedPassword,
        iv,
        authTag,
        mode: 'node',
        updatedAt: new Date().toISOString()
      });
    }
  }

  /**
   * Retrieves password for account on-demand.
   * Returns plaintext string for immediate IPC dispatch without caching plaintext in the vault entry.
   * @param {string} accountId
   * @param {string} [fallbackPassword]
   * @returns {string}
   */
  decryptCredential(accountId, fallbackPassword = null) {
    const isMasked = (pwd) => !pwd || pwd === '[PROTECTED]' || pwd.includes('***') || pwd.includes('???') || pwd.includes('•••');

    const entry = this._vault.get(accountId);
    if (entry && Buffer.isBuffer(entry.encryptedPassword)) {
      try {
        const aad = Buffer.from(`ACP_VAULT_${accountId}`, 'utf8');
        let decryptedBuf;
        if (entry.mode === 'native') {
          decryptedBuf = Buffer.from(this.native.decryptAead(entry.encryptedPassword, aad));
        } else if (entry.mode === 'node' && entry.iv && entry.authTag) {
          const decipher = crypto.createDecipheriv('aes-256-gcm', this._ephemeralKey, entry.iv);
          decipher.setAAD(aad);
          decipher.setAuthTag(entry.authTag);
          decryptedBuf = Buffer.concat([decipher.update(entry.encryptedPassword), decipher.final()]);
        }
        if (decryptedBuf) {
          const plaintext = decryptedBuf.toString('utf8');
          decryptedBuf.fill(0);
          if (plaintext && !isMasked(plaintext)) {
            return plaintext;
          }
        }
      } catch { /* ignore and fall through to SQLite store */ }
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
   * Removes credentials from memory vault and zeroes underlying buffers.
   * @param {string} accountId
   */
  evictCredential(accountId) {
    const entry = this._vault.get(accountId);
    if (entry) {
      if (Buffer.isBuffer(entry.encryptedPassword)) entry.encryptedPassword.fill(0);
      if (Buffer.isBuffer(entry.iv)) entry.iv.fill(0);
      if (Buffer.isBuffer(entry.authTag)) entry.authTag.fill(0);
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
   * Clears the entire vault (e.g. on user logout) and safely zeroes all buffers.
   */
  clear() {
    for (const entry of this._vault.values()) {
      if (Buffer.isBuffer(entry.encryptedPassword)) entry.encryptedPassword.fill(0);
      if (Buffer.isBuffer(entry.iv)) entry.iv.fill(0);
      if (Buffer.isBuffer(entry.authTag)) entry.authTag.fill(0);
    }
    this._vault.clear();
  }
}

export const vaultCredentialPipeline = new VaultCredentialPipeline();
