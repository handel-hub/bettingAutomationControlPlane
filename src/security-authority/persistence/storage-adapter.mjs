// @ts-check

/**
 * StorageAdapter boundary crossing wrapper.
 * Now fully delegates to the AEAD Storage Adapter for encrypted SQLite persistence.
 */

import { AEADStorageAdapter } from './aead-storage-adapter.mjs';

export const StorageAdapter = AEADStorageAdapter;
