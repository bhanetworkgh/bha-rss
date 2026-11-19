// BHA RSS: reads outside sources on a schedule, keeps every item in Supabase, and once a day sends one digest
// to the dashboard. Replaces Genie-RSS and ragingester.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config, missingSettings } from './config.js';
import { db } from './db.js';
import { pass, runSource, stats, stop, busy } from './scheduler.js';
import { digestPass } from './digest.js';
import { tunePass } from './tune.js';
import { reportError } from './report.js';

const digestState = { last: null, at: null };
const tuneState = { last: null, at: null };

function keyOk(req) {
  const given = Buffer.from(String(req.headers['x-api-key'] || ''));
  const want = Buffer.from(config.adminKey);
  return config.adminKey && given.length === want.length && timingSafeEqual(given, want);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function status() {
  const [sources, runs, digests] = await Promise.all([
    db.select('rss_sources', { select: 'kind,active,last_status' }),
    db.select('rss_runs', { select: 'status,items_new,started_at', started_at: `gte.${new Date(Date.now() - 86_400_000).toISOString()}` }),
    db.select('rss_digests', { select: 'digest_date,title,items_used,sources_used,delivered_at,delivery', order: 'digest_date.desc', limit: '3' }),
  ]);
  const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  return {
    sources: { total: sources.length, active_by_kind: by(sources.filter((s) => s.active), (s) => s.kind), last_status: by(sources.filter((s) => s.active), (s) => s.last_status || 'never_run') },
    runs_24h: { by_status: by(runs, (r) => r.status), new_items: runs.reduce((n, r) => n + (r.items_new || 0), 0) },
    scheduler: { on: config.schedulerOn, ...stats },
    digests,
    last_digest_pass: digestState,
    last_tune_pass: tuneState,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(res, 200, { ok: true, missing: missingSettings() });
    if (!keyOk(req)) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, await status());
    if (req.method === 'POST' && url.pathname === '/run') {
      const { source_id } = await readJson(req);
      const [source] = await db.select('rss_sources', { select: '*', id: `eq.${source_id}` });
      if (!source) return send(res, 404, { error: 'no such source' });
      return send(res, 200, await runSource(source));
    }
    if (req.method === 'POST' && url.pathname === '/pass') return send(res, 200, await pass());
    if (req.method === 'POST' && url.pathname === '/digest') {
      const body = await readJson(req);
      const now = body.date ? new Date(new Date(`${body.date}T00:00:00Z`).getTime() + 86_400_000) : new Date();
      return send(res, 200, await digestPass({ now, force: true }));
    }
    if (req.method === 'POST' && url.pathname === '/tune') return send(res, 200, await tunePass({ force: true }));
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(config.port, () => {
  const missing = missingSettings();
  console.log(`[bha-rss] listening on ${config.port}; scheduler ${config.schedulerOn ? 'on' : 'off'}; missing settings: ${missing.join(', ') || 'none'}`);
});

if (config.schedulerOn && !missingSettings().includes('SUPABASE_SERVICE_ROLE_KEY')) {
  const tick = async () => {
    await pass();
    // A failed digest or delivery is tried again after a pause, never every minute (each try can cost a model call).
    const failed = ['error', 'delivery_failed'].includes(digestState.last?.state);
    if (failed && Date.now() - new Date(digestState.at).getTime() < 15 * 60_000) return;
    try {
      digestState.last = await digestPass();
      digestState.at = new Date().toISOString();
      if (digestState.last.state === 'delivery_failed') {
        console.error('[digest] delivery failed:', digestState.last.error);
        void reportError({ kind: 'digest_not_delivered', subject: digestState.last.digest_date, digest_date: digestState.last.digest_date, error: digestState.last.error });
      }
    } catch (err) {
      digestState.last = { state: 'error', error: String(err?.message || err) };
      digestState.at = new Date().toISOString();
      console.error('[digest] failed:', digestState.last.error);
      void reportError({ kind: 'digest_failed', subject: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), error: digestState.last.error });
    }
    // Once a day, after the digest is delivered: score the sources and act on it (Genie rebuild 8.8).
    if (['tuned', 'already_ran'].includes(tuneState.last?.state) && tuneState.last.tune_date === new Date().toISOString().slice(0, 10)) return;
    if (tuneState.last?.state === 'error' && Date.now() - new Date(tuneState.at).getTime() < 30 * 60_000) return;
    try {
      tuneState.last = await tunePass();
      tuneState.at = new Date().toISOString();
    } catch (err) {
      tuneState.last = { state: 'error', error: String(err?.message || err) };
      tuneState.at = new Date().toISOString();
      console.error('[tune] failed:', tuneState.last.error);
      void reportError({ kind: 'tune_failed', subject: new Date().toISOString().slice(0, 10), error: tuneState.last.error });
    }
  };
  setTimeout(tick, 10_000);
  const timer = setInterval(tick, config.pollMs);
  process.on('SIGTERM', () => {
    stop();
    clearInterval(timer);
    console.log('[bha-rss] SIGTERM: claiming no more sources; runs in progress finish, then the process exits');
    const wait = setInterval(() => {
      if (!busy()) process.exit(0);
    }, 1000);
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}
