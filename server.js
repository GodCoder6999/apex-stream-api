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

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────
const streamCache = new Map();

function getFromCache(key) {
  const cached = streamCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  if (cached) streamCache.delete(key);
  return null;
}

function saveToCache(key, url) {
  streamCache.set(key, { url, expiresAt: Date.now() + 15 * 60 * 1000 });
}

// ─── PROXY SWARM FETCHER (Bypasses Cloudflare & Dead Render IPs) ──────────
async function fetchThroughProxies(targetUrl, isJson = false) {
  const proxies = [
    { name: 'Direct', build: url => url },
    { name: 'CorsProxy', build: url => `https://corsproxy.io/?${encodeURIComponent(url)}` },
    { name: 'CodeTabs', build: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
    { name: 'AllOrigins', build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` }
  ];

  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy.build(targetUrl), {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(6000) // Fast timeout to quickly move to the next proxy
      });

      if (res.ok) {
        const text = await res.text();
        // Check if the proxy accidentally returned a Cloudflare Captcha page
        if (text && !text.includes('Just a moment...') && !text.includes('cloudflare-core')) {
          if (isJson) {
            try { return JSON.parse(text); } catch(e) { continue; }
          }
          return text;
        }
      }
    } catch (e) {
      continue; // If this proxy fails or times out, immediately try the next one
    }
  }
  return null;
}

// ─── SMART M3U8 EXTRACTOR ─────────────────────────────────────────────────
function extractM3u8(html) {
  if (!html) return null;
  
  // 1. Look for plain text m3u8 links
  const match = html.match(/(https?:\/\/[^\s"'<>{}|\\^[\]`]+\.m3u8[^\s"'<>{}|\\^[\]`]*)/i);
  if (match) return match[1];

  // 2. Look for Base64 encoded m3u8 links (common bypass technique by VidSrc/Embed.su)
  const b64Match = html.match(/(aHR0c[A-Za-z0-9+/=]+)/g);
  if (b64Match) {
     for (const b64 of b64Match) {
        try {
           const decoded = Buffer.from(b64, 'base64').toString('utf-8');
           if (decoded.includes('.m3u8')) return decoded;
        } catch(e){}
     }
  }
  return null;
}

// ─── THE GHOST SCRAPERS (Powered by Swarm) ────────────────────────────────
const scrapers = [
  {
    name: 'VidLink (Proxy Swarm)',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/movie/${id}`;
      const html = await fetchThroughProxies(url, false);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('Failed');
    }
  },
  {
    name: 'Embed.su (Proxy Swarm)',
    scrape: async (type, id, s, e) => {
      const url = type === 'tv' ? `https://embed.su/embed/tv/${id}/${s}/${e}` : `https://embed.su/embed/movie/${id}`;
      const html = await fetchThroughProxies(url, false);
      const stream = extractM3u8(html);
      if (stream) return stream;
      throw new Error('Failed');
    }
  },
  {
    name: 'Consumet Clones (Proxy Swarm)',
    scrape: async (type, id, s, e) => {
      // If one community API dies, it loops to the next one automatically
      const instances = [
        'https://consumet-api-production-e544.up.railway.app',
        'https://c.delusionz.xyz',
        'https://consumet.vercel.app'
      ];

      for (const instance of instances) {
         const infoUrl = `${instance}/meta/tmdb/info/${id}?type=${type}`;
         const info = await fetchThroughProxies(infoUrl, true);
         if (!info) continue;

         let epId = info.episodeId || info.id;
         if (type === 'tv' && info.episodes) {
           const ep = info.episodes.find(ep => ep.season === parseInt(s) && ep.number === parseInt(e));
           if (ep) epId = ep.id;
         }

         const watchUrl = `${instance}/meta/tmdb/watch/${epId}?id=${id}`;
         const watch = await fetchThroughProxies(watchUrl, true);
         if (watch && watch.sources) {
            const source = watch.sources.find(src => src.quality === 'auto') || watch.sources[0];
            if (source?.url) return source.url;
         }
      }
      throw new Error('Failed');
    }
  }
];

// ─── 1. RESOLVE ROUTE (Checks Cache -> Swarm Scrapes -> Returns JWT) ──────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const s = req.query.s || '1';
  const e = req.query.e || '1';

  const cacheKey = `${type}:${id}:${s}:${e}`;

  try {
    let rawM3u8 = getFromCache(cacheKey);
    let sourceName = 'RAM Cache';

    if (!rawM3u8) {
      console.log(`\n🚀 [SWARM ENGINE] Hunting: ${type.toUpperCase()} ID: ${id}`);
      
      const racingTasks = scrapers.map(provider => {
        return new Promise(async (resolve, reject) => {
          try {
            const m3u8Url = await provider.scrape(type, id, s, e);
            resolve({ m3u8: m3u8Url, source: provider.name });
          } catch (err) { reject(err); }
        });
      });

      // The first successful proxy/site combination wins the race
      const winner = await Promise.any(racingTasks);
      rawM3u8 = winner.m3u8;
      sourceName = winner.source;

      saveToCache(cacheKey, rawM3u8);
    }

    console.log(`✅ [SUCCESS] Stream secured via ${sourceName}`);

    const token = jwt.sign({ url: rawM3u8, ip: req.ip }, JWT_SECRET, { expiresIn: '15m' });
    const proxied = `/api/proxy/manifest?token=${token}`;

    return res.json({ ok: true, m3u8: proxied, source: sourceName });

  } catch (aggregateError) {
    console.log(`❌ [CRITICAL FAILURE] All swarm proxies and databases failed.`);
    res.status(404).json({ ok: false, error: 'All stream providers failed.' });
  }
});

// ─── 2. SECURE MANIFEST PROXY ─────────────────────────────────────────────
app.get('/api/proxy/manifest', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const targetUrl = decoded.url;

    const upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000)
    });

    if (!upstream.ok) return res.redirect(targetUrl);

    const text = await upstream.text();
    const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

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
    res.setHeader('Cache-Control', 'public, max-age=86400');

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

app.get('/health', (_, res) => res.json({ ok: true, status: 'Cinepro Proxy Swarm Active' }));
app.listen(PORT, () => console.log(`Cinepro Backend running on :${PORT}`));
