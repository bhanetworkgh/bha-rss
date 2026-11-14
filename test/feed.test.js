import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, discoverFeedLink, looksLikeFeed } from '../src/feed.js';
import { channelIdFromUrl, channelIdFromPage, mapLinkedinPost } from '../src/collectors.js';
import { digestWindow, splitTitle } from '../src/digest.js';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Example &amp; Co</title>
<item><title><![CDATA[Vertical farms raise $10M]]></title><link>https://ex.com/a</link><guid>a-1</guid>
<pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Jane</dc:creator>
<content:encoded><![CDATA[<p>Big <b>news</b> &amp; more</p>]]></content:encoded></item>
<item><title>Second</title><link>https://ex.com/b</link><description>Plain</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<title>Some Channel</title>
<entry><id>yt:video:abc</id><yt:videoId>abc123</yt:videoId><title>Robot arms explained</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/><author><name>Some Channel</name><uri>https://x</uri></author>
<published>2026-11-13T12:00:00+00:00</published><media:group><media:description>How arms pick fruit</media:description></media:group></entry>
</feed>`;

test('RSS 2.0 items parse with CDATA, entities and dates', () => {
  const f = parseFeed(RSS);
  assert.equal(f.title, 'Example & Co');
  assert.equal(f.items.length, 2);
  const [a, b] = f.items;
  assert.equal(a.title, 'Vertical farms raise $10M');
  assert.equal(a.url, 'https://ex.com/a');
  assert.equal(a.guid, 'a-1');
  assert.equal(a.author, 'Jane');
  assert.equal(a.content, 'Big news & more');
  assert.equal(a.published_at, '2026-11-13T10:00:00.000Z');
  assert.equal(b.guid, 'https://ex.com/b');
  assert.equal(b.content, 'Plain');
  assert.equal(b.published_at, null);
});

test('YouTube Atom entries parse with video id, link and description', () => {
  const f = parseFeed(ATOM);
  assert.equal(f.title, 'Some Channel');
  assert.equal(f.items.length, 1);
  const [v] = f.items;
  assert.equal(v.guid, 'abc123');
  assert.equal(v.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(v.content, 'How arms pick fruit');
  assert.equal(v.author, 'Some Channel');
  assert.equal(v.published_at, '2026-11-13T12:00:00.000Z');
});

test('feed detection and discovery from a page', () => {
  assert.ok(looksLikeFeed(RSS));
  assert.ok(looksLikeFeed(ATOM));
  assert.ok(!looksLikeFeed('<!doctype html><html>'));
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed/"></head></html>';
  assert.equal(discoverFeedLink(html, 'https://blog.ex.com/posts'), 'https://blog.ex.com/feed/');
  assert.equal(discoverFeedLink('<html></html>', 'https://x.com'), null);
});

test('YouTube channel ids from urls and pages', () => {
  assert.equal(channelIdFromUrl('https://www.youtube.com/channel/UCUdlMZ02XYLVeknNEY8F4vw'), 'UCUdlMZ02XYLVeknNEY8F4vw');
  assert.equal(channelIdFromUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UC-b3c7kxa5vU-bnmaROgvog'), 'UC-b3c7kxa5vU-bnmaROgvog');
  assert.equal(channelIdFromUrl('https://www.youtube.com/@somehandle'), null);
  assert.equal(channelIdFromPage('..."channelId":"UCabcdefghijklmnopqrstuv"...'), 'UCabcdefghijklmnopqrstuv');
});

test('LinkedIn posts map to items', () => {
  const i = mapLinkedinPost({ text: 'First line\nmore', url: 'https://www.linkedin.com/posts/x-123/', urn: 'urn:li:1', author: { first_name: 'Sundar', last_name: 'Pichai' }, posted_at: { timestamp: 1794600000000 } });
  assert.equal(i.guid, 'urn:li:1');
  assert.equal(i.title, 'First line');
  assert.equal(i.author, 'Sundar Pichai');
  assert.ok(i.published_at.startsWith('2026-'));
});

test('the digest covers the UTC day before', () => {
  const w = digestWindow(new Date('2026-11-15T07:30:00Z'));
  assert.equal(w.digest_date, '2026-11-14');
  assert.equal(w.start.toISOString(), '2026-11-14T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-11-15T00:00:00.000Z');
});

test('the title line is split from the body', () => {
  const t = splitTitle('Outside digest -- 2026-11-14: Robots pick fruit\n\n## What moved outside\n- x', '2026-11-14');
  assert.equal(t.title, 'Outside digest -- 2026-11-14: Robots pick fruit');
  assert.ok(t.body.startsWith('## What moved outside'));
  assert.equal(splitTitle('## What moved outside', '2026-11-14').title, 'Outside digest -- 2026-11-14');
});
