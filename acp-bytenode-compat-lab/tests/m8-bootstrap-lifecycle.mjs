// acp-bytenode-compat-lab/tests/m8-bootstrap-lifecycle.mjs
// M8: Control Plane full bootstrap & subsystem initialization compatibility tests

import fs from 'node:fs';
import path from 'node:path';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { StorageAdapter } from '../../src/security-authority/persistence/storage-adapter.mjs';
import { initDevToken, authConfig } from '../../src/api-server/middleware/auth.mjs';
import { registerDefaultCommandHandlers } from '../../src/command/registerCommands.mjs';
import { commandRouter } from '../../src/command/commandRouter.mjs';
import { getSharedStateStore } from '../../src/state-store/sharedStateStore.mjs';

export function registerM8Tests(harness) {
  harness.test('M8-001', 'SecurityFacade initialization & state engine readiness', 'M8-Lifecycle', async () => {
    const tmpDir = path.resolve(process.cwd(), '.tmp-compat-lab');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const testDb = path.join(tmpDir, 'm8-sec.db');
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);

    if (StorageAdapter._db) {
      await StorageAdapter._db.close();
      StorageAdapter._db = null;
    }

    await securityFacade.initialize(testDb);
    const isDegraded = securityFacade.isDegraded();
    return { initialized: true, degradedState: isDegraded };
  });

  harness.test('M8-002', 'Ingress developer token generation & retrieval', 'M8-Lifecycle', async () => {
    const token = initDevToken();

    if (!token || typeof token !== 'string' || token.length < 10) {
      throw new Error(`Invalid dev token generated: ${token}`);
    }

    return { tokenLength: token.length, tokenFormatValid: true };
  });

  harness.test('M8-003', 'Command router registration & default handler dispatch', 'M8-Lifecycle', async () => {
    registerDefaultCommandHandlers();
    
    // Test routing a known command
    const res = await commandRouter.route({
      id: 'cmd_compat_001',
      category: 'System',
      type: 'VIEW_STATUS',
      payload: { reason: 'COMPAT_LAB_VERIFY' }
    });

    return { commandHandled: true, result: res };
  });

  harness.test('M8-004', 'Shared StateStore initialization & default account seeding', 'M8-Lifecycle', async () => {
    const store = getSharedStateStore();
    const accounts = store.accountsContainer.getAll();

    if (!accounts || accounts.length === 0) {
      throw new Error('Default accounts were not seeded in StateStore');
    }

    return { seededCount: accounts.length, lifecycleReady: true };
  });
}
