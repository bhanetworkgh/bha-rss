import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pass, stop, busy } from '../src/scheduler.js';

test('once told to stop, a pass claims nothing', async () => {
  stop();
  assert.deepEqual(await pass(), { skipped: 'stopping' });
  assert.equal(busy(), false);
});
