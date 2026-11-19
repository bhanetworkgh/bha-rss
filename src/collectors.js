// One collector per kind of source. Each returns { items, cursor } and throws with a plain reason on failure.
import { config } from './config.js';
import { parseFeed, looksLikeFeed, discoverFeedLink, stripHtml } from './feed.js';
import { heldGuids, enrichArticles, enrichYoutube, articlesRefusedRecently, REFUSED_RECHECK_DAYS, apifyBlocked, isAccountBlock, noteApifyBlock } from './enrich.js';
import { reportError } from './report.js';

const UA = 'Mozilla/5.0 (compatible; BHA-RSS/1.0; +https://bhanetwork.org)';

async function get(url, accept = '*/*') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return text;
}

// RSS: the source url may be the feed itself or a page that advertises one; the found feed is kept in the cursor.
export async function collectRss(source) {
  const feedUrl = source.cursor?.feed_url || source.url;
  let text = await get(feedUrl, 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*');
  let usedUrl = feedUrl;
  if (!looksLikeFeed(text)) {
    const found = discoverFeedLink(text, feedUrl);
    if (!found) throw new Error(`no feed at ${feedUrl}, and the page advertises none`);
    text = await get(found, 'application/rss+xml, application/atom+xml, */*');
    if (!looksLikeFeed(text)) throw new Error(`the feed the page advertises (${found}) is not a feed`);
    usedUrl = found;
  }
  const feed = parseFeed(text);
  const held = await heldGuids(source.id, feed.items.map((i) => i.guid));
  const cursor = { ...source.cursor, feed_url: usedUrl, feed_title: feed.title };
  // A site that refused article reads within the last week is not asked again; the feed's own text is kept.
  if (articlesRefusedRecently(source.cursor)) {
    for (const it of feed.items) {
      if (!held.has(it.guid) && it.url) it.meta = { ...(it.meta || {}), capture: 'feed', article_note: `the site refuses article reads (answered ${source.cursor.articles_refused_status}); checked again after ${REFUSED_RECHECK_DAYS} days` };
    }
    return { items: feed.items, warnings: [], cursor };
  }
  const { warnings, refused_status } = await enrichArticles(feed.items, held);
  if (refused_status) {
    // Not a failure: the items are kept as the feed gave them, each says why, and the source remembers it
    // on its cursor. It raises no error card.
    cursor.articles_refused_at = new Date().toISOString();
    cursor.articles_refused_status = refused_status;
  } else if (source.cursor?.articles_refused_at) {
    delete cursor.articles_refused_at;
    delete cursor.articles_refused_status;
  }
  return { items: feed.items, warnings, cursor };
}

// YouTube: every channel has a free Atom feed of its latest videos; only the channel id is needed.
export function channelIdFromUrl(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('channel_id');
    if (q) return q;
    const m = u.pathname.match(/\/channel\/(UC[\w-]{20,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function channelIdFromPage(html) {
  const patterns = [
    /"channelId":"(UC[\w-]{20,})"/,
    /<meta itemprop="(?:channelId|identifier)" content="(UC[\w-]{20,})"/,
    /youtube\.com\/channel\/(UC[\w-]{20,})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

export async function collectYoutube(source) {
  let channelId = source.cursor?.channel_id || channelIdFromUrl(source.url);
  if (!channelId) {
    channelId = channelIdFromPage(await get(source.url, 'text/html'));
    if (!channelId) throw new Error(`could not find the channel id on ${source.url}`);
  }
  const feed = parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, 'application/atom+xml'));
  const held = await heldGuids(source.id, feed.items.map((i) => i.guid));
  const warnings = await enrichYoutube(feed.items, held);
  return { items: feed.items, warnings, cursor: { ...source.cursor, channel_id: channelId, feed_title: feed.title } };
}

// LinkedIn: a profile's recent posts through the Apify actor Genie-RSS used.
export function mapLinkedinPost(item) {
  const author = item.author ? `${item.author.first_name || ''} ${item.author.last_name || ''}`.trim() : null;
  const ts = item.posted_at?.timestamp ?? item.posted_at?.date;
  const d = ts ? new Date(ts) : null;
  const url = item.url || '';
  const guid = item.urn || item.full_urn || url.split('/').filter(Boolean).pop() || null;
  const text = item.text || '';
  const rs = item.reshared_post || item.resharedPost || null;
  const reshared = rs && rs.text
    ? { text: rs.text, url: rs.url || null, author: rs.author ? `${rs.author.first_name || ''} ${rs.author.last_name || ''}`.trim() || rs.author.name || null : null }
    : null;
  return {
    guid,
    url: url || null,
    title: text ? text.split('\n')[0].slice(0, 140) : 'LinkedIn post',
    author,
    content: reshared ? `${text}\n\nShared post${reshared.author ? ' by ' + reshared.author : ''}:\n${reshared.text}` : text,
    published_at: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
    meta: {
      capture: 'post',
      post_type: item.post_type || null,
      stats: item.stats || null,
      reshared: reshared ? { author: reshared.author, url: reshared.url } : null,
      article: item.article ? { title: item.article.title || null, url: item.article.url || item.article.link || null } : null,
      document: item.document ? { title: item.document.title || null } : null,
      media: item.media ? { type: item.media.type || null, count: Array.isArray(item.media.images) ? item.media.images.length : null } : null,
    },
  };
}

export async function collectLinkedin(source) {
  if (!config.apifyToken) throw new Error('APIFY_TOKEN is not set, so LinkedIn cannot be read');
  // The Apify account is blocked (one service_blocked card says so): the profile is read again once the hold ends.
  if (apifyBlocked()) return { items: [], cursor: source.cursor || {} };
  const n = config.linkedinPosts;
  const res = await fetch(
    `https://api.apify.com/v2/actors/apimaestro~linkedin-profile-posts/run-sync-get-dataset-items?token=${config.apifyToken}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [source.url], username: source.url, page_number: 1, limit: n, total_posts: n }),
      signal: AbortSignal.timeout(config.apifyTimeoutMs),
    }
  );
  const text = await res.text();
  if (!res.ok && isAccountBlock(res.status, text)) {
    noteApifyBlock(res.status, text, reportError);
    return { items: [], cursor: source.cursor || {} };
  }
  if (!res.ok) throw new Error(`Apify answered ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('Apify did not return a list of posts');
  const items = data.map(mapLinkedinPost).filter((i) => i.guid);
  return { items, cursor: source.cursor || {} };
}

// Web: one page, kept as one item that changes when the page's text changes.
export async function collectWeb(source) {
  const html = await get(source.url, 'text/html');
  const title = stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') || source.url;
  const body = stripHtml((html.match(/<body[\s\S]*<\/body>/i) || [html])[0]).slice(0, 20_000);
  const { createHash } = await import('node:crypto');
  const guid = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return { items: [{ guid, url: source.url, title, author: null, content: body, published_at: null }], cursor: source.cursor || {} };
}

export const collectors = { rss: collectRss, youtube: collectYoutube, linkedin: collectLinkedin, web: collectWeb };
