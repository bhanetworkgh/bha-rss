import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from '../src/collectors.js';

const reply = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const fake = (statuses) => { const calls = []; return { calls, fn: async (url) => { calls.push(url); return reply(statuses.shift(), 'ok-body'); } }; };

test('a 503 that clears on the next try is read, not failed', async () => {
  const f = fake([503, 200]);
  assert.equal(await get('https://x.test/feed', '*/*', { fetchImpl: f.fn, waits: [0, 0] }), 'ok-body');
  assert.equal(f.calls.length, 2);
});

test('a 503 that never clears fails after three tries and says so', async () => {
  const f = fake([503, 503, 503]);
  await assert.rejects(get('https://x.test/feed', '*/*', { fetchImpl: f.fn, waits: [0, 0] }), /answered 503 \(tried 3 times\)/);
  assert.equal(f.calls.length, 3);
});

test('a 404 fails at once, with no retry', async () => {
  const f = fake([404]);
  await assert.rejects(get('https://x.test/feed', '*/*', { fetchImpl: f.fn, waits: [0, 0] }), /answered 404$/);
  assert.equal(f.calls.length, 1);
});
