// Genie rebuild step 4.2: a failure is reported to the dashboard, base64-wrapped, and a report that does not land
// never throws into the run it is about.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_INBOUND_KEY = 'k';
process.env.DASHBOARD_URL = 'https://dash.example';
const { reportError } = await import('../src/report.js');

test('posts the report to the dashboard with the inbound key, wrapped in body_b64', async () => {
  let call;
  const fetchImpl = async (url, init) => { call = { url, init }; return { ok: true, status: 200, text: async () => '{"ok":true,"posted":true}' }; };
  const r = await reportError({ kind: 'source_failed', subject: 'src-1', error: 'answered 404' }, fetchImpl);
  assert.deepEqual(r, { ok: true, posted: true });
  assert.equal(call.url, 'https://dash.example/api/engine/rss-error');
  assert.equal(call.init.headers['x-dashboard-key'], 'k');
  const sent = JSON.parse(Buffer.from(JSON.parse(call.init.body).body_b64, 'base64').toString('utf8'));
  assert.equal(sent.kind, 'source_failed');
  assert.ok(sent.at);
});

test('a dashboard refusal or a network error is returned, never thrown', async () => {
  const refused = await reportError({ kind: 'pass_failed', subject: 'scheduler', error: 'x' }, async () => ({ ok: false, status: 422, text: async () => '{"ok":false}' }));
  assert.equal(refused.ok, false);
  const down = await reportError({ kind: 'pass_failed', subject: 'scheduler', error: 'x' }, async () => { throw new Error('ECONNRESET'); });
  assert.deepEqual(down, { ok: false, error: 'ECONNRESET' });
});
