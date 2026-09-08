// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '../src/command/command.mjs';
import { CommandPayloadSchema, ContractViolationError } from '../src/command/commandSchema.mjs';
import { CommandRouter } from '../src/command/commandRouter.mjs';

test('Command: constructor assigns ULID, priority, and deep freezes', () => {
  const cmd = new Command({
    category: 'Execution',
    type: 'START_AUTOMATION',
    payload: { runMode: 'HEADLESS' }
  });

  assert.ok(cmd.id, 'Expected command ID');
  assert.equal(cmd.priority, 'NORMAL');
  assert.equal(cmd.category, 'Execution');
  assert.equal(cmd.type, 'START_AUTOMATION');
  assert.ok(Object.isFrozen(cmd));
  assert.ok(Object.isFrozen(cmd.payload));

  // Should throw when modifying frozen command
  assert.throws(() => {
    // @ts-ignore
    cmd.category = 'Billing';
  }, TypeError);
});

test('CommandPayloadSchema: rejects invalid category or missing type', () => {
  // @ts-ignore
  const v1 = CommandPayloadSchema.validate({ id: '1', category: 'InvalidCategory', type: 'FOO' });
  assert.equal(v1.valid, false);
  assert.match(v1.errors[0], /Invalid or missing category/);

  // @ts-ignore
  const v2 = CommandPayloadSchema.validate({ id: '1', category: 'Execution' });
  assert.equal(v2.valid, false);
  assert.match(v2.errors[0], /Missing or invalid command type/);
});

test('CommandPayloadSchema: validates PLACE_BET payload constraints', () => {
  const v1 = CommandPayloadSchema.validate({
    id: '1',
    category: 'Execution',
    type: 'PLACE_BET',
    payload: { stake: -100 }
  });
  assert.equal(v1.valid, false);
  assert.match(v1.errors[0], /positive number/);

  const v2 = CommandPayloadSchema.validate({
    id: '2',
    category: 'Execution',
    type: 'PLACE_BET',
    payload: { stake: 500, odds: 1.85 }
  });
  assert.equal(v2.valid, true);
});

test('CommandRouter: routes commands and maintains metrics', async () => {
  const router = new CommandRouter();
  let executed = false;

  router.register('Execution', 'START_AUTOMATION', async (cmd) => {
    executed = true;
    return { ok: true };
  });

  const res = await router.route({
    id: 'cmd-1',
    category: 'Execution',
    type: 'START_AUTOMATION',
    payload: {}
  });

  assert.equal(res.success, true);
  assert.equal(executed, true);
  assert.deepEqual(res.results, [{ ok: true }]);

  const metrics = router.getIngressMetrics();
  assert.equal(metrics.received, 1);
  assert.equal(metrics.routed, 1);
  assert.equal(metrics.rejected, 0);
});

test('CommandRouter: throws ContractViolationError on invalid schema (LF-701)', async () => {
  const router = new CommandRouter();

  await assert.rejects(
    async () => {
      await router.route({
        id: 'bad-1',
        category: 'NonExistentCategory',
        type: 'TEST'
      });
    },
    (err) => {
      assert.ok(err instanceof ContractViolationError);
      assert.equal(err.code, 'LF-701');
      return true;
    }
  );

  const metrics = router.getIngressMetrics();
  assert.equal(metrics.rejected, 1);
});
