import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── RAW HTTP FETCHER ─────────────────────────────────────────────────────
// Silently catches errors so the server NEVER crashes
async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

// ─── REGEX M3U8 EXTRACTOR ─────────────────────────────────────────────────
function extractM3u8(html) {
  if (!html) return null;
  // Hunts through the raw page code for any hidden m3u8 playlist links
  const match = html.match(/(https?:\/\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_.-]+\/[^\s"'<>{}|\\^[\]`]+\.m3u8[^\s"'<>{}|\\^[\]`]*)/i);
  return match ? match[1] : null;
}

// ─── THE CINEPRO MULTI-SCRAPER TARGETS ────────────────────────────────────
const scrapers = [
  {
    name: 'VidLink API',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/movie/${id}`;
      const html = await fetchHtml(url);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('No stream found');
    }
  },
  {
    name: 'AutoEmbed',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/movie/${id}`;
      const html = await fetchHtml(url);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('No stream found');
    }
  },
  {
    name: 'VidSrc CC',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` : `https://vidsrc.cc/v2/embed/movie/${id}`;
      const html = await fetchHtml(url);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('No stream found');
    }
  },
  {
    name: 'Embed.su',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://embed.su/embed/tv/${id}/${s}/${e}` : `https://embed.su/embed/movie/${id}`;
      const html = await fetchHtml(url);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('No stream found');
    }
  },
  {
    name: 'MultiEmbed',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}` : `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`;
      const html = await fetchHtml(url);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('No stream found');
    }
  }
];

// ─── THE SHOTGUN ROUTE ────────────────────────────────────────────────────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const s = req.query.s || '1';
  const e = req.query.e || '1';

  console.log(`\n🚀 [CINEPRO ENGINE] Target: ${type.toUpperCase()} ID: ${id}`);

  // Map the scrapers into an array of racing Promises
  const racingTasks = scrapers.map(provider => {
    return new Promise(async (resolve, reject) => {
      try {
        const m3u8Url = await provider.scrape(type, id, s, e);
        resolve({ m3u8: m3u8Url, source: provider.name });
      } catch (err) {
        reject(err); // Reject silently to let Promise.any keep searching
      }
    });
  });

  try {
    // Promise.any() fires all scrapers at once and grabs the very first success
    const winner = await Promise.any(racingTasks);
    
    console.log(`✅ [STREAM SECURED] Extracted from: ${winner.source}`);

    // Proxy the stream to bypass browser CORS blocks on the frontend
    const proxied = `/api/proxy?url=${encodeURIComponent(winner.m3u8)}`;

    return res.json({ 
      ok: true, 
      m3u8: proxied, 
      source: winner.source, 
      raw: winner.m3u8 
    });

  } catch (aggregateError) {
    console.log(`❌ [CRITICAL FAILURE] All iframe providers blocked the datacenter IP.`);
    res.status(404).json({ 
      ok: false, 
      error: 'All stream providers failed or blocked the request.' 
    });
  }
});

// ─── PROXY FOR VIDEO CHUNKS ───────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('missing url');

  let target = raw;
  try { target = decodeURIComponent(raw); } catch (e) {}

  let origin;
  try { origin = new URL(target).origin; } catch { origin = 'https://vidlink.pro'; }

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': UA, Referer: origin + '/', Origin: origin, Accept: '*/*' },
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`);

    const ct = upstream.headers.get('content-type') || '';
    const isM3u8 = ct.toLowerCase().includes('mpegurl') || target.includes('.m3u8');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (isM3u8) {
      const text = await upstream.text();
      const base = target.substring(0, target.lastIndexOf('/') + 1);
      const rewritten = rewriteManifest(text, base, req);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ct || 'video/mp2t');
    return res.send(buf);
  } catch (e) {
    return res.status(502).send(`fetch error: ${e.message}`);
  }
});

function rewriteManifest(text, base, req) {
  const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?url=`;
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxyBase}${encodeURIComponent(toAbs(uri, base))}"`);
    return proxyBase + encodeURIComponent(toAbs(t, base));
  }).join('\n');
}

function toAbs(url, base) {
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) { try { return new URL(base).origin + url; } catch {} }
  return base + url;
}

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`apex-stream-api running on :${PORT}`));
