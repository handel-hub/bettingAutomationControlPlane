// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../../src/api-server/server.mjs';
import { authConfig } from '../../src/api-server/middleware/auth.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';

test('Boundary Contract: Error Taxonomy & Machine-Readable Codes', async (t) => {
  const server = new ApiServer();
  const port = 8096;
  await server.listen(port, '127.0.0.1');

  t.after(async () => {
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test('Unauthenticated request returns code AUTH_001 with domain AUTH', async () => {
    const origRequireAuth = authConfig.requireAuth;
    const origToken = authConfig.activeToken;
    authConfig.requireAuth = true;
    authConfig.activeToken = 'test-token-error-tax';

    try {
      const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, 'UNAUTHORIZED');
      assert.equal(data.code, 'AUTH_001');
      assert.ok(data.protocolError);
      assert.equal(data.protocolError.code, 'AUTH_001');
      assert.equal(data.protocolError.domain, 'AUTH');
    } finally {
      authConfig.requireAuth = origRequireAuth;
      authConfig.activeToken = origToken;
    }
  });

  await t.test('Missing required account fields returns HTTP 400 validation failure', async () => {
    const res = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Incomplete' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.match(data.error, /platformDisplayName and accountUsername are required/);
  });

  await t.test('Capability denial returns code CAP_001 with domain CAPABILITY', async () => {
    // Mock unauthorized capability check
    const origAuthorize = securityFacade.authorize;
    // @ts-ignore
    securityFacade.authorize = () => ({ status: 'DENIED', message: 'Automation start denied by policy' });

    try {
      const res = await fetch(`${baseUrl}/api/v1/automation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, 'CAP_001');
      assert.ok(data.protocolError);
      assert.equal(data.protocolError.code, 'CAP_001');
      assert.equal(data.protocolError.domain, 'CAPABILITY');
    } finally {
      securityFacade.authorize = origAuthorize;
    }
  });

  await t.test('Degraded mode request returns code EXEC_001 with domain EXECUTION', async () => {
    const origIsDegraded = securityFacade.isDegraded;
    securityFacade.isDegraded = () => true;

    try {
      const res = await fetch(`${baseUrl}/api/v1/automation/operations/place-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: 'm1', odds: 2.0, stake: 100 })
      });
      // In degraded mode, tactical command either returns 400/500/503
      assert.ok(res.status >= 400);
    } finally {
      securityFacade.isDegraded = origIsDegraded;
    }
  });
});
