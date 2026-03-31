import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

// ─── ENTERPRISE CONFIGURATION ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_cinepro_key_123';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── IN-MEMORY CACHE (Replaces Paid Redis) ────────────────────────────────
// Stores scraped links in RAM for 15 minutes to prevent Cloudflare bans
const streamCache = new Map();

function getFromCache(key) {
  const cached = streamCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  if (cached) streamCache.delete(key);
  return null;
}

function saveToCache(key, url) {
  // Cache the link for 15 minutes
  streamCache.set(key, { url, expiresAt: Date.now() + 15 * 60 * 1000 });
}

// ─── SAFE FETCHER ─────────────────────────────────────────────────────────
async function safeFetchJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ─── THE GHOST SCRAPERS (Cloudflare Bypassed) ─────────────────────────────
const scrapers = [
  {
    name: 'MultiEmbed (Redirect)',
    scrape: async (type, id, s, e) => {
      const url = type === 'movie'
        ? `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`
        : `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}`;
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
      if (res.url && (res.url.includes('.m3u8') || res.url.includes('.mp4'))) return res.url;
      throw new Error('No redirect stream found');
    }
  },
  {
    name: 'Consumet (AllOrigins Mask)',
    scrape: async (type, id, s, e) => {
      const proxy = 'https://api.allorigins.win/raw?url=';
      const infoUrl = proxy + encodeURIComponent(`https://c.delusionz.xyz/meta/tmdb/info/${id}?type=${type}`);
      const info = await safeFetchJson(infoUrl);
      if (!info) throw new Error('Info fetch blocked');

      let epId = info.episodeId || info.id;
      if (type === 'tv' && info.episodes) {
        const ep = info.episodes.find(ep => ep.season === parseInt(s) && ep.number === parseInt(e));
        if (ep) epId = ep.id;
      }

      const watchUrl = proxy + encodeURIComponent(`https://c.delusionz.xyz/meta/tmdb/watch/${epId}?id=${id}`);
      const watch = await safeFetchJson(watchUrl);
      if (!watch || !watch.sources) throw new Error('Watch fetch blocked');

      const source = watch.sources.find(src => src.quality === 'auto') || watch.sources[0];
      if (source?.url) return source.url;
      throw new Error('No stream in JSON');
    }
  }
];

// ─── 1. RESOLVE ROUTE (Checks Cache -> Scrapes -> Returns JWT) ────────────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const s = req.query.s || '1';
  const e = req.query.e || '1';

  const cacheKey = `${type}:${id}:${s}:${e}`;

  try {
    // 1. Check RAM Cache
    let rawM3u8 = getFromCache(cacheKey);
    let sourceName = 'RAM Cache';

    // 2. If not cached, fire the scrapers asynchronously
    if (!rawM3u8) {
      console.log(`\n🚀 [ENGINE] Scraping: ${type.toUpperCase()} ID: ${id}`);
      const racingTasks = scrapers.map(provider => {
        return new Promise(async (resolve, reject) => {
          try {
            const m3u8Url = await provider.scrape(type, id, s, e);
            resolve({ m3u8: m3u8Url, source: provider.name });
          } catch (err) { reject(err); }
        });
      });

      const winner = await Promise.any(racingTasks);
      rawM3u8 = winner.m3u8;
      sourceName = winner.source;

      // Save to RAM so the next user loads instantly
      saveToCache(cacheKey, rawM3u8);
    }

    console.log(`✅ [SUCCESS] Stream secured via ${sourceName}`);

    // 3. Cryptographically sign the raw URL to protect your Render bandwidth
    const token = jwt.sign({ url: rawM3u8, ip: req.ip }, JWT_SECRET, { expiresIn: '15m' });

    // 4. Return the secure proxy route to the frontend
    const proxied = `/api/proxy/manifest?token=${token}`;

    return res.json({ ok: true, m3u8: proxied, source: sourceName });

  } catch (aggregateError) {
    console.log(`❌ [CRITICAL FAILURE] All providers blocked.`);
    res.status(404).json({ ok: false, error: 'All stream providers failed.' });
  }
});

// ─── 2. SECURE MANIFEST PROXY (Verifies JWT -> Rewrites URIs) ─────────────
app.get('/api/proxy/manifest', async (req, res) => {
  const { token } = req.query;

  if (!token) return res.status(400).send('Missing token');

  try {
    // 1. Verify the JWT. If a hacker tries to guess the URL, this crashes and blocks them.
    const decoded = jwt.verify(token, JWT_SECRET);
    const targetUrl = decoded.url;

    // 2. Fetch the actual master manifest
    const upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000)
    });

    if (!upstream.ok) return res.redirect(targetUrl); // Failsafe

    const text = await upstream.text();
    const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // 3. Rewrite the .ts video chunk URLs to route through our Chunk Proxy
    const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy/chunk?url=`;
    const rewritten = text.split('\n').map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxyBase}${encodeURIComponent(toAbs(uri, base))}"`);
      }
      return proxyBase + encodeURIComponent(toAbs(t, base));
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(rewritten);

  } catch (error) {
    return res.status(403).send('Invalid or expired token.');
  }
});

// ─── 3. VIDEO CHUNK PROXY ─────────────────────────────────────────────────
app.get('/api/proxy/chunk', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('missing url');

  let target = decodeURIComponent(raw);
  let origin = new URL(target).origin;

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': UA, Referer: origin + '/', Origin: origin },
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok) return res.redirect(target);

    const ct = upstream.headers.get('content-type') || 'video/mp2t';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache chunks in browser

    // If it's a nested m3u8 (resolutions), rewrite it too
    if (ct.toLowerCase().includes('mpegurl') || target.includes('.m3u8')) {
      const text = await upstream.text();
      const base = target.substring(0, target.lastIndexOf('/') + 1);
      const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy/chunk?url=`;
      const rewritten = text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        return proxyBase + encodeURIComponent(toAbs(t, base));
      }).join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // Pipe the binary video data to the player
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ct);
    return res.send(buf);
  } catch (e) {
    return res.redirect(target);
  }
});

function toAbs(url, base) {
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) { try { return new URL(base).origin + url; } catch {} }
  return base + url;
}

app.get('/health', (_, res) => res.json({ ok: true, status: 'Cinepro Free Tier Active' }));
app.listen(PORT, () => console.log(`Cinepro Backend running on :${PORT}`));
