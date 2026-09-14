// @ts-check
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseCorruptError } from '../types/errors.mjs';

/**
 * SQLite Storage Engine wrapping better-sqlite3 with WAL PRAGMAs,
 * integrity verification, and self-healing error trapping.
 */
export class SqliteStorageEngine {
  /**
   * @param {string} dbPath Absolute file path or ':memory:'
   * @param {object} [options]
   * @param {boolean} [options.readOnly=false]
   */
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.options = options;
    /** @type {import('better-sqlite3').Database | null} */
    this.db = null;
    this.isOpen = false;
  }

  /**
   * Opens SQLite database connection and sets production PRAGMAs.
   */
  open() {
    if (this.isOpen) return;

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    try {
      this.db = new Database(this.dbPath, {
        readonly: !!this.options.readOnly,
        timeout: 5000
      });

      // Enforce PRAGMAs
      if (this.dbPath !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
      }
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('cache_size = -8000'); // 8MB page cache
      this.db.pragma('temp_store = MEMORY');

      this.isOpen = true;
    } catch (err) {
      if (this.db) {
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }
      this.isOpen = false;
      throw err;
    }
  }

  /**
   * Performs SQLite integrity check.
   * Throws DatabaseCorruptError if quick_check returns anything other than 'ok'.
   */
  quickCheck() {
    if (!this.db) throw new Error('Database not open');
    try {
      const rows = this.db.pragma('quick_check');
      if (!Array.isArray(rows) || rows.length === 0 || rows[0].quick_check !== 'ok') {
        const details = JSON.stringify(rows);
        throw new DatabaseCorruptError(details);
      }
      return true;
    } catch (err) {
      if (err instanceof DatabaseCorruptError) throw err;
      throw new DatabaseCorruptError(err.message);
    }
  }

  /**
   * Runs a function inside a native SQLite transaction.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    if (!this.db) throw new Error('Database not open');
    const tx = this.db.transaction(fn);
    return tx();
  }

  /**
   * Prepares a SQL statement.
   * @param {string} sql
   */
  prepare(sql) {
    if (!this.db) throw new Error('Database not open');
    return this.db.prepare(sql);
  }

  /**
   * Executes a query returning all rows.
   * @param {string} sql
   * @param {...any} params
   */
  query(sql, ...params) {
    if (!this.db) throw new Error('Database not open');
    const flatParams = Array.isArray(params[0]) ? params[0] : params;
    return this.db.prepare(sql).all(...flatParams);
  }

  /**
   * Executes a statement returning run result.
   * @param {string} sql
   * @param {...any} params
   */
  run(sql, ...params) {
    if (!this.db) throw new Error('Database not open');
    const flatParams = Array.isArray(params[0]) ? params[0] : params;
    return this.db.prepare(sql).run(...flatParams);
  }

  /**
   * Executes multiple SQL statements.
   * @param {string} sql
   */
  exec(sql) {
    if (!this.db) throw new Error('Database not open');
    return this.db.exec(sql);
  }

  /**
   * Reads or sets user_version pragma.
   * @param {number} [version]
   * @returns {number}
   */
  userVersion(version = null) {
    if (!this.db) throw new Error('Database not open');
    if (version !== null) {
      this.db.pragma(`user_version = ${Number(version)}`);
      return Number(version);
    }
    const row = this.db.pragma('user_version', { simple: true });
    return Number(row);
  }

  /**
   * Closes database handle cleanly and checkpoints WAL.
   */
  close() {
    if (this.db) {
      try {
        if (this.dbPath !== ':memory:') {
          try {
            this.db.pragma('wal_checkpoint(TRUNCATE)');
          } catch { /* ignore */ }
        }
        this.db.close();
      } catch { /* ignore */ }
      this.db = null;
    }
    this.isOpen = false;
  }
}
