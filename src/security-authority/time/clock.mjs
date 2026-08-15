// @ts-check

import { PersistentClock } from './persistent-clock.mjs';
import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';

export const clock = new PersistentClock(AEADStorageAdapter);

// It must be initialized at boot time
// We will export an init helper
export async function initClock() {
  await clock.initialize();
}
