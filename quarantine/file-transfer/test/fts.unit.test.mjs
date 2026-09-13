import test from 'node:test';
import assert from 'node:assert';
import { TransferStateMachine } from '../state/TransferStateMachine.mjs';

test('TransferStateMachine Transitions', async (t) => {
  const mockRepo = {
    queueTransfer: (id) => {},
    startUpload: () => true,
    updateChunkState: () => {},
    markVerifying: () => {},
    markCompleted: () => {},
    failTransfer: () => {},
    markRetrying: () => {},
    markPaused: () => {}
  };
  
  const mockEventBus = {
    emitTransferEvent: (name, payload) => {}
  };

  const config = {
    chunkSize: 10,
    retryPolicy: { hotBaseMs: 1, hotFactor: 1, hotMaxMs: 1, hotMaxAttempts: 2 }
  };

  const sm = new TransferStateMachine(mockRepo, mockEventBus, config);

  await t.test('queues transfer', () => {
    let queued = false;
    mockRepo.queueTransfer = () => { queued = true; };
    sm.queue('t1');
    assert.strictEqual(queued, true);
  });

  await t.test('chunkFailedRetryable - within hot attempts limits', () => {
    let retrying = false;
    mockRepo.markRetrying = () => { retrying = true; };
    const state = sm.chunkFailedRetryable('t1', 0, 1, 3, new Error('network drop'));
    assert.strictEqual(state, 'RETRY_WAIT');
    assert.strictEqual(retrying, true);
  });

  await t.test('chunkFailedRetryable - exceeds hot attempts limits', () => {
    let paused = false;
    mockRepo.markPaused = () => { paused = true; };
    const state = sm.chunkFailedRetryable('t1', 0, 3, 3, new Error('network drop'));
    assert.strictEqual(state, 'PAUSED');
    assert.strictEqual(paused, true);
  });
});
