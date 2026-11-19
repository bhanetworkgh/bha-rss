// Once a day: compile what came in from outside into one digest, keep it here, and hand it to the dashboard,
// which stores it, sends it to BHARAG and serves it to Media Twin, Genie, Research Twin and North Star.
import { config } from './config.js';
import { db } from './db.js';

const PER_ITEM_CHARS = 600;

export function digestWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  return { digest_date: start.toISOString().slice(0, 10), start, end };
}

// The day is due once its window has closed and the configured hour has passed.
export function isDue(now = new Date()) {
  return now.getUTCHours() >= config.digestHourUtc;
}

const SYSTEM = `You write the daily outside digest for Bays Horizon Advisory (BHA).
BHA builds vFarm (a small indoor vertical farm cabinet with sensors, a camera and a robot arm, sold to homes and offices), an AI automation engine of agents (Bays, North Star, Research Twin, Genie, a Media Twin that drafts social posts, a Customer Service Twin) and works on capital for the company.
You are given items collected yesterday from outside sources: news and blog feeds, YouTube channels and LinkedIn profiles. Write only from those items. Never invent a fact, number, name or link. Every point carries the link of the item it came from, as [title](url).
Write in plain words, short sentences, no em dashes, no hype.

Use exactly these sections, in Markdown:
## What moved outside
3 to 6 bullets: the most important developments, each one sentence and its link.
## Post ideas for the Media Twin
2 to 5 ideas a builder-in-public account could post about, each tied to one item and to something BHA actually builds. Skip this section's bullets and write "Nothing fits today." if nothing fits honestly.
## Questions for Research Twin
1 to 4 questions worth looking into further, each with the item that raised it.
## Signals for North Star
Bullets on anything that could change what BHA should prioritise (indoor farming, AI agents and automation, customer service AI, robotics, capital and funding). Write "No priority signal today." if there is none.
## Context for Genie
2 to 5 short facts a builder asking Genie might need, each with its link.

Every bullet in every section starts with one or more lane tags, so it can be routed: [CAPITAL] funding, investors, valuations and markets; [VFARM] indoor and vertical farming, growing, food and the cabinet's hardware; [PHYSICAL_AI] robots, arms, sensors, cameras and machines acting in the world; [MODELS] AI models, chips, compute and their cost; [AGENTS] AI agents, automation, customer service AI and the tools around them. Use only these tags, in capitals and square brackets, before any other text on the bullet, for example "- [MODELS] [CAPITAL] ...". If none fits, use [OTHER]. The lines "Nothing fits today." and "No priority signal today." are not bullets and take no tag.

Your first line is the title: "Outside digest -- <date>: <the single biggest thing in 8 words or fewer>". Then a blank line, then the sections.`;

// Genie rebuild step 8.7 (Jason, 17 Nov 2026, #bha-engine-digests 1794857554.370099): every bullet carries a lane tag.
export const LANE_TAGS = ['CAPITAL', 'VFARM', 'PHYSICAL_AI', 'MODELS', 'AGENTS', 'OTHER'];
const TAG_RUN = new RegExp(`^(\\[(?:${LANE_TAGS.join('|')})\\]\\s*)+`);

// The bullets that do not open with a known lane tag. Bullets are lines starting "- ", "* " or "1. ".
export function untaggedBullets(body) {
  return String(body || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => /^([-*\u2022]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*\u2022]|\d+\.)\s+/, ''))
    .filter((l) => !TAG_RUN.test(l));
}

function itemLine(it) {
  const src = it.rss_sources ? `${it.rss_sources.kind}: ${it.rss_sources.name || it.rss_sources.cursor?.feed_title || it.rss_sources.url}` : 'unknown source';
  const body = (it.content || '').replace(/\s+/g, ' ').slice(0, PER_ITEM_CHARS);
  return `- [${src}] ${it.title}\n  link: ${it.url || 'none'}\n  ${body}`;
}

async function callModel(date, items, correction) {
  const res = await fetch(`${config.openrouterUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.openrouterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.digestModel,
      max_tokens: 16000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Date: ${date}\n${items.length} items:\n\n${items.map(itemLine).join('\n')}` },
        ...(correction ? [{ role: 'assistant', content: correction.text }, { role: 'user', content: correction.ask }] : []),
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('the model returned no text');
  if (data?.choices?.[0]?.finish_reason === 'length') throw new Error('the model was cut off before the digest ended');
  return out;
}

export function splitTitle(text, date) {
  const lines = text.split('\n');
  const first = lines[0].replace(/^#+\s*/, '').trim();
  if (/^outside digest/i.test(first)) return { title: first, body: lines.slice(1).join('\n').trim() };
  return { title: `Outside digest -- ${date}`, body: text.trim() };
}

async function deliver(digest, items) {
  const cited = items.slice(0, 200).map((i) => ({ title: i.title, url: i.url, kind: i.rss_sources?.kind, source: i.rss_sources?.name || i.rss_sources?.url }));
  const payload = {
    digest_date: digest.digest_date,
    title: digest.title,
    body: digest.body,
    period_start: digest.period_start,
    period_end: digest.period_end,
    items_used: digest.items_used,
    sources_used: digest.sources_used,
    model: digest.model,
    items: cited,
  };
  const body_b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const res = await fetch(`${config.dashboardUrl}/api/engine/outside-digest`, {
    method: 'POST',
    headers: { 'x-dashboard-key': config.dashboardKey, 'content-type': 'application/json' },
    body: JSON.stringify({ body_b64 }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || !parsed?.ok) throw new Error(`dashboard answered ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

async function itemsFor(win) {
  const since = new Date(win.start.getTime() - 86_400_000).toISOString();
  return db.select('rss_items', {
    select: 'id,title,url,content,published_at,fetched_at,rss_sources(kind,name,url,cursor)',
    digest_id: 'is.null',
    fetched_at: `lt.${win.end.toISOString()}`,
    or: `(published_at.gte.${since},and(published_at.is.null,fetched_at.gte.${win.start.toISOString()}))`,
    order: 'published_at.desc.nullslast',
    limit: String(config.maxItemsPerDigest),
  });
}

// Makes the digest for the day that just ended if it is not held, and delivers any held digest not yet delivered.
export async function digestPass({ now = new Date(), force = false } = {}) {
  const win = digestWindow(now);
  const out = { digest_date: win.digest_date };
  let [digest] = await db.select('rss_digests', { select: '*', digest_date: `eq.${win.digest_date}` });
  if (!digest) {
    if (!force && !isDue(now)) return { ...out, state: 'not_due' };
    const items = await itemsFor(win);
    if (!items.length) return { ...out, state: 'no_items' };
    let text = await callModel(win.digest_date, items);
    let missing = untaggedBullets(splitTitle(text, win.digest_date).body);
    if (missing.length) {
      // Asked once more with the bullets named; still untagged is a failure, reported, never posted half-tagged.
      const ask = `${missing.length} bullet(s) have no lane tag. Write the whole digest again, same content, with every bullet opening with its lane tags from the list. Untagged: ${missing.slice(0, 5).map((m) => m.slice(0, 80)).join(' | ')}`;
      text = await callModel(win.digest_date, items, { text, ask });
      missing = untaggedBullets(splitTitle(text, win.digest_date).body);
      if (missing.length) throw new Error(`${missing.length} digest bullet(s) still had no lane tag after one retry, e.g. "${missing[0].slice(0, 120)}"`);
    }
    const { title, body } = splitTitle(text, win.digest_date);
    const sources = new Set(items.map((i) => i.rss_sources?.url));
    [digest] = await db.insert('rss_digests', [{
      digest_date: win.digest_date,
      period_start: win.start.toISOString(),
      period_end: win.end.toISOString(),
      title,
      body,
      items_used: items.length,
      sources_used: sources.size,
      model: config.digestModel,
    }]);
    for (let i = 0; i < items.length; i += 100) {
      const ids = items.slice(i, i + 100).map((x) => x.id).join(',');
      await db.update('rss_items', { id: `in.(${ids})` }, { digest_id: digest.id });
    }
    digest._items = items;
    out.created = true;
  }
  if (digest.delivered_at) return { ...out, state: 'delivered', digest_id: digest.id };
  const items = digest._items || (await db.select('rss_items', { select: 'title,url,rss_sources(kind,name,url)', digest_id: `eq.${digest.id}`, limit: '200' }));
  try {
    const answer = await deliver(digest, items);
    await db.update('rss_digests', { id: `eq.${digest.id}` }, { delivered_at: new Date().toISOString(), delivery: answer });
    return { ...out, state: 'delivered', digest_id: digest.id, delivery: answer };
  } catch (err) {
    const reason = String(err?.message || err);
    await db.update('rss_digests', { id: `eq.${digest.id}` }, { delivery: { ok: false, error: reason, at: new Date().toISOString() } });
    return { ...out, state: 'delivery_failed', digest_id: digest.id, error: reason };
  }
}
