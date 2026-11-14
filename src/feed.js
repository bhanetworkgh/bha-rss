// Reads RSS 2.0, RSS 1.0 (RDF) and Atom (YouTube channel feeds are Atom) with no outside package.
// It is deliberately forgiving: a feed that parses badly gives fewer items, never a crash.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function unwrapCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function stripHtml(s) {
  if (!s) return '';
  return decodeEntities(
    s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// First matching child element's inner text. `names` are tried in order; namespaces kept literal (media:description).
function child(block, names) {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, 'i');
    const m = block.match(re);
    if (m) return unwrapCdata(m[1]).trim();
  }
  return '';
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
}

function atomLink(block) {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = '';
  for (const l of links) {
    const rel = attr(l, 'rel');
    const href = attr(l, 'href');
    if (!href) continue;
    if (!rel || rel === 'alternate') return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

function isoDate(v) {
  if (!v) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function blocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export function looksLikeFeed(text) {
  const head = (text || '').slice(0, 2000).toLowerCase();
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf');
}

// Returns { title, items: [{ guid, url, title, author, content, published_at }] }.
export function parseFeed(xml) {
  const text = xml || '';
  const isAtom = /<feed[\s>]/i.test(text.slice(0, 3000));
  const feedTitle = stripHtml(child(text.replace(/<(entry|item)[\s\S]*$/i, ''), ['title']));
  const raw = isAtom ? blocks(text, 'entry') : blocks(text, 'item');
  const items = [];
  for (const b of raw) {
    const title = stripHtml(child(b, ['title']));
    const url = isAtom ? atomLink(b) : decodeEntities(child(b, ['link']) || atomLink(b));
    const guid = decodeEntities(child(b, ['yt:videoId', 'id', 'guid'])) || url || title;
    const content = stripHtml(
      child(b, ['content:encoded', 'media:description', 'content', 'summary', 'description'])
    );
    const author = stripHtml(child(b, ['dc:creator', 'author', 'name']).replace(/<uri>[\s\S]*?<\/uri>/i, ''));
    const published_at = isoDate(child(b, ['pubDate', 'published', 'updated', 'dc:date']));
    if (!guid) continue;
    items.push({ guid: guid.slice(0, 500), url: url || null, title: title || 'Untitled', author: author || null, content, published_at });
  }
  return { title: feedTitle || null, items };
}

// Finds a feed link advertised in an HTML page.
export function discoverFeedLink(html, pageUrl) {
  const links = (html || '').match(/<link\b[^>]*>/gi) || [];
  for (const l of links) {
    const type = attr(l, 'type').toLowerCase();
    const rel = attr(l, 'rel').toLowerCase();
    if (rel.includes('alternate') && (type.includes('rss') || type.includes('atom'))) {
      const href = attr(l, 'href');
      if (href) {
        try { return new URL(href, pageUrl).toString(); } catch { /* ignore */ }
      }
    }
  }
  return null;
}
