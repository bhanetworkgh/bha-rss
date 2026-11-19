// Richer capture (15 Nov 2026, Destiny): a feed gives a headline and two lines, a YouTube feed gives the
// description box. For items not already held, this fetches what was actually said: the article's own text,
// and the video's transcript and details through an Apify actor. Each step is bounded per run, and a step
// that fails leaves the item as the feed gave it and names why in the item's meta, never drops it.
import { config } from './config.js';
import { db } from './db.js';
import { stripHtml } from './feed.js';
import { reportError } from './report.js';

const UA = 'Mozilla/5.0 (compatible; BHA-RSS/1.0; +https://bhanetwork.org)';

// The guids of these items this source already holds, so only new items are enriched (and paid for).
export async function heldGuids(sourceId, guids) {
  const held = new Set();
  for (let i = 0; i < guids.length; i += 50) {
    const list = guids.slice(i, i + 50).map((g) => `"${String(g).replace(/["\\]/g, '\\$&')}"`).join(',');
    const rows = await db.select('rss_items', { select: 'guid', source_id: `eq.${sourceId}`, guid: `in.(${list})` });
    for (const r of rows || []) held.add(r.guid);
  }
  return held;
}

// The main text of an article page: the <article> (else <main>, else the body) with navigation, scripts and
// boilerplate taken out, kept as its paragraphs, headings and list items.
export function articleText(html) {
  if (!html) return '';
  const clean = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const scope =
    (clean.match(/<article[\s\S]*<\/article>/i) || [])[0] ||
    (clean.match(/<main[\s\S]*<\/main>/i) || [])[0] ||
    (clean.match(/<body[\s\S]*<\/body>/i) || [clean])[0];
  const parts = [];
  for (const m of scope.matchAll(/<(p|h2|h3|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = stripHtml(m[2]).replace(/\s+/g, ' ').trim();
    if (t.length >= 40 || (m[1] !== 'p' && m[1] !== 'li' && t.length >= 12)) parts.push(t);
  }
  return [...new Set(parts)].join('\n\n');
}

// A site that refuses to hand an article to a reader that is not signed in (a paywall: 401, 402, 403, 451)
// refuses every article on it, so after the first refusal the rest of its items in that run are left as the
// feed gave them, and the source remembers it for a week (17 Nov 2026, Bloomberg Markets: ten 403s every day,
// each one an error card, while the feed itself read fine). It is one note when first seen, never a daily card.
export const REFUSED_STATUSES = new Set([401, 402, 403, 451]);
export const REFUSED_RECHECK_DAYS = 7;

// Whether articles on this source were refused recently enough that they are not tried again yet. Pure.
export function articlesRefusedRecently(cursor, now = Date.now()) {
  const at = Date.parse(cursor?.articles_refused_at || '');
  return Number.isFinite(at) && now - at < REFUSED_RECHECK_DAYS * 86_400_000;
}

// Opens each new short item's link and keeps the article's own text when it is longer than what the feed gave.
// Returns the warnings, and refused_status when the site refused articles (the caller notes it on the source).
export async function enrichArticles(items, held, limit = config.articlesPerRun, fetchImpl = fetch) {
  const warnings = [];
  let tried = 0;
  let refused = null;
  for (const it of items) {
    if (held.has(it.guid) || !it.url || (it.content || '').length >= config.shortContentChars) continue;
    if (refused) {
      it.meta = { ...(it.meta || {}), capture: 'feed', article_note: refused === 429 ? 'the site asked us to slow down (answered 429)' : `the site refuses article reads (answered ${refused})` };
      continue;
    }
    if (tried >= limit) break;
    tried += 1;
    try {
      const res = await fetchImpl(it.url, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(config.fetchTimeoutMs),
      });
      if (res.status === 429) {
        // The site is throttling this reader (19 Nov 2026: CoinDesk answered 429 to ten articles in a row and that
        // was a daily card). It is not a fault: the rest of this run's items keep the feed's text, and nothing is reported.
        refused = 429;
        it.meta = { ...(it.meta || {}), capture: 'feed', article_note: 'the site asked us to slow down (answered 429)' };
        continue;
      }
      if (REFUSED_STATUSES.has(res.status)) {
        refused = res.status;
        it.meta = { ...(it.meta || {}), capture: 'feed', article_note: `the site refuses article reads (answered ${refused})` };
        continue;
      }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const text = articleText(await res.text());
      if (text.length > (it.content || '').length + 200) {
        it.meta = { ...(it.meta || {}), feed_summary: it.content || '', capture: 'article' };
        it.content = text;
      } else {
        it.meta = { ...(it.meta || {}), capture: 'feed', article_note: 'the page gave no more text than the feed' };
      }
    } catch (err) {
      const reason = String(err?.message || err).slice(0, 200);
      it.meta = { ...(it.meta || {}), capture: 'feed', article_error: reason };
      warnings.push(`article ${it.url}: ${reason}`);
    }
  }
  return { warnings, refused_status: refused === 429 ? null : refused };
}

export function videoIdOf(item) {
  const g = String(item.guid || '');
  const m = g.match(/^yt:video:([\w-]{11})$/) || String(item.url || '').match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Apify is one paid account behind every YouTube transcript and every LinkedIn read. When the account itself is
// blocked (19 Nov 2026: the Free plan's $5 a month ran out and every call answered 403 platform-feature-disabled),
// every source failed on its own and each posted its own card. Now the first blocked answer holds every Apify call
// for APIFY_HOLD_MS (6 hours), the items are still saved with what the feed gave, and one service_blocked card is
// sent for the whole account (the dashboard says it once a day).
export class ApifyBlockedError extends Error {}
export const apifyHold = { until: 0, reason: '' };
export const APIFY_HOLD_MS = 6 * 3_600_000;

// Whether an Apify answer is the account being blocked, not one actor or one input failing. Pure.
export function isAccountBlock(status, text) {
  if (status === 402) return true;
  if (status !== 403 && status !== 429) return false;
  return /platform-feature-disabled|monthly usage|usage limit|exceeded|payment|billing|plan/i.test(String(text || ''));
}

export function apifyBlocked(now = Date.now()) {
  return apifyHold.until > now;
}

// Called by every Apify caller on a response that was not ok. Starts the hold and sends one card; returns the error.
export function noteApifyBlock(status, text, report, now = Date.now()) {
  const fresh = !apifyBlocked(now);
  apifyHold.until = now + APIFY_HOLD_MS;
  apifyHold.reason = `Apify answered ${status}: ${String(text || '').slice(0, 300)}`;
  if (fresh && report) void report({ kind: 'service_blocked', subject: 'apify', source_name: 'Apify (YouTube transcripts and LinkedIn)', source_url: 'https://console.apify.com/billing', error: `${apifyHold.reason} Every Apify call is held for 6 hours; items are still saved, without transcripts or LinkedIn posts.` });
  return new ApifyBlockedError(apifyHold.reason);
}

async function apify(actor, input) {
  if (!config.apifyToken) throw new Error('APIFY_TOKEN is not set');
  if (apifyBlocked()) throw new ApifyBlockedError(apifyHold.reason);
  const res = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${config.apifyToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(config.apifyTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok && isAccountBlock(res.status, text)) throw noteApifyBlock(res.status, text, reportError);
  if (!res.ok) throw new Error(`Apify ${actor} answered ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`Apify ${actor} did not return a list`);
  return data;
}

// One transcript row onto its feed item: the description, then everything said in the video, plus its details.
export function applyTranscript(it, row) {
  const full = (row.fullText || (row.segments || []).map((s) => s.text).join(' ') || '').replace(/\s+/g, ' ').trim();
  const desc = (row.description || it.content || '').trim();
  it.meta = {
    ...(it.meta || {}),
    capture: full ? 'transcript' : 'description',
    transcript_chars: full.length,
    transcript_language: row.selectedLanguage || row.language || null,
    auto_captions: row.isAutoGenerated ?? null,
    views: row.viewCount ?? null,
    duration_s: row.durationSeconds ?? null,
    keywords: Array.isArray(row.keywords) ? row.keywords.slice(0, 20) : null,
    channel: row.channelName || null,
  };
  if (!full) it.meta.transcript_note = 'the video has no captions';
  it.content = full ? `${desc}\n\nTranscript:\n${full}` : desc;
}

// The newest new videos of a run get their transcript and details; the rest keep the feed's description.
export async function enrichYoutube(items, held, limit = config.transcriptsPerRun) {
  const fresh = items.filter((it) => !held.has(it.guid) && videoIdOf(it)).slice(0, limit);
  if (!fresh.length) return [];
  let rows;
  try {
    rows = await apify(config.transcriptActor, {
      urls: fresh.map((it) => `https://www.youtube.com/watch?v=${videoIdOf(it)}`),
      language: 'en',
      includeAutoGenerated: true,
      mergeSegments: true,
    });
  } catch (err) {
    const reason = String(err?.message || err).slice(0, 300);
    if (err instanceof ApifyBlockedError) {
      // The account is blocked: said once for the whole account, not as this source's failure.
      for (const it of fresh) it.meta = { ...(it.meta || {}), capture: 'description', transcript_note: 'no transcript: the Apify account is blocked (usage limit)' };
      return [];
    }
    for (const it of fresh) it.meta = { ...(it.meta || {}), capture: 'description', transcript_error: reason };
    return [`transcripts: ${reason}`];
  }
  const byId = new Map(rows.filter((r) => r && r.videoId).map((r) => [r.videoId, r]));
  const warnings = [];
  for (const it of fresh) {
    const row = byId.get(videoIdOf(it));
    if (row) applyTranscript(it, row);
    else {
      it.meta = { ...(it.meta || {}), capture: 'description', transcript_error: 'no row came back for this video' };
      warnings.push(`transcript ${videoIdOf(it)}: no row came back`);
    }
  }
  return warnings;
}
