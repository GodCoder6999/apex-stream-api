import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── SAFE FETCHER ─────────────────────────────────────────────────────────
// Wraps JSON fetches so dead domains or Cloudflare blocks NEVER crash the server
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
    name: 'MultiEmbed (Redirect Bypass)',
    scrape: async (type, id, s, e) => {
      // This bypasses HTML entirely. It forces the server to follow a redirect
      // and rips the m3u8 link directly out of the final destination URL.
      const url = type === 'movie'
        ? `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`
        : `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}`;
        
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
      if (res.url && (res.url.includes('.m3u8') || res.url.includes('.mp4'))) return res.url;
      throw new Error('No redirect stream found');
    }
  },
  {
    name: 'Consumet API (Masked via AllOrigins)',
    scrape: async (type, id, s, e) => {
      // Routes the request through AllOrigins to hide Render's Datacenter IP
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
  },
  {
    name: 'Consumet API (Masked via CodeTabs)',
    scrape: async (type, id, s, e) => {
      // Routes the request through CodeTabs proxy as a secondary IP mask
      const proxy = 'https://api.codetabs.com/v1/proxy?quest=';
      const infoUrl = proxy + encodeURIComponent(`https://consumet-api-production-e544.up.railway.app/meta/tmdb/info/${id}?type=${type}`);
      
      const info = await safeFetchJson(infoUrl);
      if (!info) throw new Error('Info fetch blocked');

      let epId = info.episodeId || info.id;
      if (type === 'tv' && info.episodes) {
        const ep = info.episodes.find(ep => ep.season === parseInt(s) && ep.number === parseInt(e));
        if (ep) epId = ep.id;
      }

      const watchUrl = proxy + encodeURIComponent(`https://consumet-api-production-e544.up.railway.app/meta/tmdb/watch/${epId}?id=${id}`);
      const watch = await safeFetchJson(watchUrl);
      if (!watch || !watch.sources) throw new Error('Watch fetch blocked');

      const source = watch.sources.find(src => src.quality === 'auto') || watch.sources[0];
      if (source?.url) return source.url;
      throw new Error('No stream in JSON');
    }
  }
];

// ─── THE AGGREGATOR ENGINE ────────────────────────────────────────────────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const s = req.query.s || '1';
  const e = req.query.e || '1';

  console.log(`\n🚀 [GHOST ENGINE] Target: ${type.toUpperCase()} ID: ${id}`);

  // Map all ghost scrapers to run at the exact same time
  const racingTasks = scrapers.map(provider => {
    return new Promise(async (resolve, reject) => {
      try {
        console.log(`[Hunting] -> ${provider.name}...`);
        const m3u8Url = await provider.scrape(type, id, s, e);
        resolve({ m3u8: m3u8Url, source: provider.name });
      } catch (err) {
        reject(err); // Silently reject so the engine keeps searching the other APIs
      }
    });
  });

  try {
    // The very first API to successfully return an m3u8 wins
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
    console.log(`❌ [CRITICAL FAILURE] All masked proxies and redirects failed.`);
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

    if (!upstream.ok) {
      // If the proxy fails to fetch the video chunk, redirect the frontend to play the raw URL directly
      return res.redirect(target);
    }

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
    // Failsafe: if proxy crashes, let the player try the raw link
    return res.redirect(target);
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
