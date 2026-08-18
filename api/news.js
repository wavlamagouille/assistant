// Combines a few RSS feeds into one headline list. No API key, no account,
// no Vercel env vars needed — public RSS feeds, fetched server-side to avoid
// the CORS issues most news sites' feeds have when fetched directly from a
// browser. Edit FEEDS below to swap sources.

const FEEDS = [
  { url: 'http://feeds.bbci.co.uk/news/rss.xml', source: 'BBC' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://www.attackmagazine.com/feed/', source: 'Attack Mag' }
];

export default async function handler(req, res) {
  const results = await Promise.allSettled(
    FEEDS.map(f => fetchFeed(f.url, f.source))
  );

  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed.push(FEEDS[i].source);
  });

  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  res.status(200).json({
    items: items.slice(0, 40),
    failedSources: failed
  });
}

async function fetchFeed(url, source) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WavAssistant/1.0)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = await r.text();

  const items = [];
  const blocks = xml.split('<item>').slice(1);
  for (const block of blocks) {
    const body = block.split('</item>')[0];
    const title = extractTag(body, 'title');
    const link = extractTag(body, 'link');
    const pubDate = extractTag(body, 'pubDate');
    if (!title) continue;
    items.push({
      title,
      link: link || null,
      date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      source
    });
  }
  return items;
}

function extractTag(body, tag) {
  const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return null;
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) val = cdata[1].trim();
  return val;
}
