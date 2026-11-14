// Reads every due source, a few at a time, and keeps what it collects. One pass per POLL_MS.
import { config } from './config.js';
import { db } from './db.js';
import { collectors } from './collectors.js';

const MAX_CONTENT = 20_000;
let running = false;
export const stats = { passes: 0, lastPassAt: null, lastPassRuns: 0, lastError: null };

function nextRun(source) {
  // A little spread so 150 sources set to one interval do not all fall due in the same minute again.
  const jitter = Math.floor(Math.random() * 10 * 60_000);
  return new Date(Date.now() + source.every_hours * 3_600_000 + jitter).toISOString();
}

// Claims the source by moving next_run_at only if nobody moved it first; false means another pass has it.
async function claim(source) {
  const rows = await db.update(
    'rss_sources',
    { id: `eq.${source.id}`, next_run_at: `eq.${source.next_run_at}` },
    { next_run_at: nextRun(source), updated_at: new Date().toISOString() }
  );
  return rows && rows.length === 1;
}

export async function runSource(source) {
  const [run] = await db.insert('rss_runs', [{ source_id: source.id, status: 'running' }]);
  const collect = collectors[source.kind];
  try {
    if (!collect) throw new Error(`no collector for kind ${source.kind}`);
    const { items, cursor } = await collect(source);
    let added = [];
    if (items.length) {
      const rows = items.map((i) => ({
        source_id: source.id,
        guid: i.guid,
        url: i.url,
        title: (i.title || '').slice(0, 500),
        author: i.author ? i.author.slice(0, 200) : null,
        content: (i.content || '').slice(0, MAX_CONTENT),
        published_at: i.published_at,
      }));
      added = (await db.insertNew('rss_items', rows, 'source_id,guid')) || [];
    }
    const now = new Date().toISOString();
    await db.update('rss_runs', { id: `eq.${run.id}` }, { status: 'success', items_seen: items.length, items_new: added.length, ended_at: now });
    await db.update('rss_sources', { id: `eq.${source.id}` }, { last_run_at: now, last_status: 'success', last_error: null, cursor, updated_at: now });
    return { ok: true, source_id: source.id, seen: items.length, new: added.length };
  } catch (err) {
    const now = new Date().toISOString();
    const reason = String(err?.message || err).slice(0, 1000);
    await db.update('rss_runs', { id: `eq.${run.id}` }, { status: 'failed', error: reason, ended_at: now });
    await db.update('rss_sources', { id: `eq.${source.id}` }, { last_run_at: now, last_status: 'failed', last_error: reason, updated_at: now });
    return { ok: false, source_id: source.id, error: reason };
  }
}

export async function pass() {
  if (running) return { skipped: true };
  running = true;
  try {
    const due = await db.select('rss_sources', {
      select: '*',
      active: 'eq.true',
      next_run_at: `lte.${new Date().toISOString()}`,
      order: 'next_run_at.asc',
      limit: String(config.concurrency * 5),
    });
    const results = [];
    for (let i = 0; i < due.length; i += config.concurrency) {
      const batch = due.slice(i, i + config.concurrency);
      const done = await Promise.all(
        batch.map(async (s) => ((await claim(s)) ? runSource(s) : { ok: true, source_id: s.id, skipped: 'claimed elsewhere' }))
      );
      results.push(...done);
    }
    stats.passes += 1;
    stats.lastPassAt = new Date().toISOString();
    stats.lastPassRuns = results.length;
    stats.lastError = null;
    return { ran: results.length, failed: results.filter((r) => !r.ok).length };
  } catch (err) {
    stats.lastError = String(err?.message || err);
    console.error('[scheduler] pass failed:', stats.lastError);
    return { error: stats.lastError };
  } finally {
    running = false;
  }
}
