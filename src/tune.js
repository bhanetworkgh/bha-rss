// BHA RSS tunes its own sources (19 Nov 2026, Destiny, Genie rebuild 8.8). Once a day, after the digest is
// delivered: count how many digest bullets in the last 30 days linked each source's items, find sites the cited
// items link to that are not yet a source, and send both to the dashboard, which adds how often those links were
// then used (Media Twin, Research Twin, North Star, Genie), scores each source and decides how often to read it.
// This applies what the dashboard decided, adds any candidate a person approved, and says what it did.
// No model in the loop. The rule lives on the dashboard (server/src/outsideSources.ts, RULE).
import { config } from './config.js';
import { db } from './db.js';

const WINDOW_DAYS = 30;
const CANDIDATE_MIN_ITEMS = 3;
// Sites that are platforms or link shorteners, never a source in their own right.
const NOT_A_SOURCE = new Set([
  'youtube.com', 'youtu.be', 'linkedin.com', 'lnkd.in', 'x.com', 'twitter.com', 't.co', 'facebook.com', 'instagram.com',
  'tiktok.com', 'google.com', 'goo.gl', 'bit.ly', 'ow.ly', 'buff.ly', 'apple.com', 'spotify.com', 'amazon.com', 'github.com',
  'medium.com', 'substack.com', 'reddit.com', 'wikipedia.org', 'doubleclick.net', 'feedburner.com', 'w3.org', 'schema.org',
]);

export const host = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const platform = (h) => [...NOT_A_SOURCE].some((p) => h === p || h.endsWith(`.${p}`));

// Every markdown link on a bullet line, counted once per bullet.
export function citedLinks(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    if (!/^\s*([-*]|\d+\.)\s/.test(line)) continue;
    const seen = new Set();
    for (const m of line.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

// Sites linked from inside cited items' own text, not already a source, with the cited items that link them.
export function candidates(items, sourceHosts) {
  const by = new Map();
  for (const it of items) {
    const own = host(it.url);
    for (const m of String(it.content || '').matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
      const h = host(m[0]);
      if (!h || h === own || sourceHosts.has(h) || platform(h)) continue;
      if (!by.has(h)) by.set(h, new Set());
      by.get(h).add(it.url);
    }
  }
  return [...by.entries()]
    .filter(([, s]) => s.size >= CANDIDATE_MIN_ITEMS)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([h, s]) => ({ host: h, evidence: [...s].slice(0, 10) }));
}

const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function post(path, body) {
  const res = await fetch(`${config.dashboardUrl}${path}`, {
    method: 'POST',
    headers: { 'x-dashboard-key': config.dashboardKey, 'content-type': 'application/json' },
    body: JSON.stringify({ body_b64: Buffer.from(JSON.stringify(body), 'utf8').toString('base64') }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || parsed?.ok === false) throw new Error(`dashboard ${path} ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

// One pass a UTC day. Claimed by a row in rss_tune_runs; a failed day is tried again after 30 minutes.
async function claim(tuneDate) {
  const [row] = (await db.insertNew('rss_tune_runs', [{ tune_date: tuneDate }], 'tune_date')) || [];
  if (row) return row;
  const before = new Date(Date.now() - 30 * 60_000).toISOString();
  const [retry] = (await db.update('rss_tune_runs', { tune_date: `eq.${tuneDate}`, status: 'eq.failed', ended_at: `lt.${before}` }, { status: 'running', started_at: new Date().toISOString(), error: null, ended_at: null })) || [];
  return retry || null;
}

export async function tunePass({ now = new Date(), force = false } = {}) {
  const tuneDate = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (!force) {
    const [d] = await db.select('rss_digests', { select: 'delivered_at', digest_date: `eq.${yesterday}` });
    if (!d?.delivered_at) return { state: 'waiting_for_digest', tune_date: tuneDate };
  }
  const run = await claim(tuneDate);
  if (!run) return { state: 'already_ran', tune_date: tuneDate };
  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const digests = await db.select('rss_digests', { select: 'digest_date,body', digest_date: `gte.${since}`, order: 'digest_date.asc' });
    const links = digests.flatMap((d) => citedLinks(d.body));
    const distinct = [...new Set(links)];
    const items = [];
    for (let i = 0; i < distinct.length; i += 25) {
      const chunk = distinct.slice(i, i + 25);
      items.push(...(await db.select('rss_items', { select: 'url,source_id,content', url: `in.(${chunk.map(quote).join(',')})` })));
    }
    const sourceOf = new Map();
    for (const it of items) if (!sourceOf.has(it.url)) sourceOf.set(it.url, it.source_id);
    const tally = new Map();
    for (const u of links) {
      const s = sourceOf.get(u);
      if (!s) continue;
      const t = tally.get(s) || { cited: 0, urls: new Set() };
      t.cited += 1;
      t.urls.add(u);
      tally.set(s, t);
    }
    const sources = await db.select('rss_sources', { select: 'id,kind,name,url,active,every_hours,base_every_hours,created_at,next_run_at' });
    const sourceHosts = new Set(sources.map((s) => host(s.url)).filter((h) => h && !platform(h)));
    const first = digests[0]?.digest_date;
    const historyDays = first ? Math.max(0, Math.round((new Date(`${tuneDate}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / 86_400_000)) : 0;
    const plan = await post('/api/engine/outside-sources/score', {
      tune_date: tuneDate,
      history_days: historyDays,
      sources: sources.map((s) => ({ ...s, cited: tally.get(s.id)?.cited || 0, cited_urls: [...(tally.get(s.id)?.urls || [])] })),
      candidates: candidates(items, sourceHosts),
    });

    const byId = new Map(sources.map((s) => [s.id, s]));
    const applied = [];
    const failed = [];
    const at = new Date().toISOString();
    for (const c of plan.changes || []) {
      try {
        const s = byId.get(c.source_id);
        if (!s) throw new Error('no such source here');
        const patch = { tuned_at: at, tune_reason: String(c.reason || '').slice(0, 500), updated_at: at, base_every_hours: s.base_every_hours || s.every_hours };
        if (c.action === 'retire') Object.assign(patch, { active: false, retired_at: at });
        else {
          patch.every_hours = Number(c.every_hours);
          if (!(patch.every_hours > 0)) throw new Error(`bad interval ${c.every_hours}`);
          // Read sooner straight away when a source is moved up; a slower one keeps its next run and waits longer after.
          const soonest = new Date(now.getTime() + patch.every_hours * 3_600_000).toISOString();
          if (s.next_run_at > soonest) patch.next_run_at = soonest;
        }
        const rows = await db.update('rss_sources', { id: `eq.${s.id}` }, patch);
        if (!rows?.length) throw new Error('update changed nothing');
        applied.push(c.change_id);
      } catch (err) {
        failed.push({ id: c.change_id, error: String(err?.message || err).slice(0, 300) });
      }
    }
    const added = [];
    for (const a of plan.approved || []) {
      try {
        const existing = await db.select('rss_sources', { select: 'id', url: `eq.${a.feed_url}` });
        const [row] = existing.length ? existing : await db.insert('rss_sources', [{ kind: a.kind, url: a.feed_url, name: a.name || null, active: true, every_hours: 24, base_every_hours: 24, origin: 'candidate', tune_reason: `approved candidate ${a.candidate_id}` }]);
        added.push({ candidate_id: a.candidate_id, source_id: row.id });
      } catch (err) {
        failed.push({ id: a.candidate_id, error: String(err?.message || err).slice(0, 300) });
      }
    }
    const done = await post('/api/engine/outside-sources/applied', { tune_date: tuneDate, applied, failed, added });
    const result = { scored: plan.scored, counts: plan.counts, applied: applied.length, failed: failed.length, added: added.length, history_days: historyDays, cited_links: links.length, confirmed: done.applied };
    await db.update('rss_tune_runs', { id: `eq.${run.id}` }, { status: failed.length ? 'partial' : 'done', ended_at: new Date().toISOString(), result });
    return { state: 'tuned', tune_date: tuneDate, ...result };
  } catch (err) {
    const error = String(err?.message || err).slice(0, 1000);
    await db.update('rss_tune_runs', { id: `eq.${run.id}` }, { status: 'failed', ended_at: new Date().toISOString(), error });
    throw err;
  }
}
