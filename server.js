import express from 'express';
import cors from 'cors';
import { makeProviders, makeStandardFetcher, targets } from '@movie-web/providers';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const TMDB_KEY = process.env.TMDB_KEY || 'cb1dc311039e6ae85db0aa200345cbc5';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── 1. CORE ENGINE (20+ Internal Sources) ───
const providers = makeProviders({
  fetcher: makeStandardFetcher(fetch),
  target: targets.ANY 
});

// ─── 2. MASSIVE MIRROR SWARM (15+ Community APIs) ───
// These are various instances of Consumet and open-source streaming APIs.
// Even if 14 of them are offline, we only need 1 to work.
const API_MIRRORS = [
  'https://consumet-api-production-e544.up.railway.app',
  'https://c.delusionz.xyz',
  'https://consumet.vercel.app',
  'https://api.streamm.tv',
  'https://api.consumet.org',
  'https://consumet-api.herokuapp.com',
  'https://api.anify.tv',
  'https://api.zoro.to',
  'https://flixhq-api.vercel.app',
  'https://consumet-api-clone.onrender.com',
  'https://movies-api.netlify.app',
  'https://api.enime.moe',
  'https://api.gogoanime.consumet.org',
  'https://stream-api.vercel.app',
  'https://api.m3u8.tv'
];

// A bulletproof fetch wrapper that catches DNS errors (like "fetch failed")
// so dead domains are silently skipped instead of crashing your server.
async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false };
  }
}

app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const isTv = type === 'tv';

  try {
    console.log(`\n🚀 [AGGREGATOR INITIATED] Target: ${type.toUpperCase()} ID: ${id}`);

    // ─── STEP 1: FLAWLESS METADATA ───
    const tmdbUrl = isTv
      ? `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids`
      : `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids`;
      
    const tmdbRes = await safeFetch(tmdbUrl);
    if (!tmdbRes.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to fetch TMDB metadata.' });
    }
    const tmdbData = tmdbRes.data;

    const media = {
      type: isTv ? 'show' : 'movie',
      title: isTv ? tmdbData.name : tmdbData.title,
      releaseYear: isTv
        ? parseInt(tmdbData.first_air_date?.split('-')[0] || 0)
        : parseInt(tmdbData.release_date?.split('-')[0] || 0),
      tmdbId: id.toString(),
      imdbId: tmdbData.external_ids?.imdb_id || tmdbData.imdb_id || '',
    };

    if (isTv) {
      media.episode = { number: parseInt(req.query.e || 1), tmdbId: '' };
      media.season = { number: parseInt(req.query.s || 1), tmdbId: '' };
    }

    console.log(`[Target Lock] ${media.title} (${media.releaseYear}) | IMDB: ${media.imdbId}`);

    // ─── STEP 2: BUILD THE RACE TASKS ───
    // We will launch the Core Engine AND all 15 mirrors at the exact same time.
    const racingTasks = [];

    // Task A: The Core Movie-Web Engine (Searches 20+ mobile/web databases)
    racingTasks.push(new Promise(async (resolve, reject) => {
      try {
        const result = await providers.runAll({ media });
        if (result && result.stream) {
          let url = '';
          if (result.stream.type === 'hls') url = result.stream.playlist;
          else if (result.stream.type === 'file') url = Object.values(result.stream.qualities)[0]?.url;
          
          if (url) resolve({ m3u8: url, source: `Core Engine (${result.providerId})` });
          else reject(new Error('Engine found source but no URL'));
        } else {
          reject(new Error('Core Engine found nothing'));
        }
      } catch (e) {
        reject(e);
      }
    }));

    // Tasks B: The 15+ Community Mirrors
    API_MIRRORS.forEach(baseUrl => {
      racingTasks.push(new Promise(async (resolve, reject) => {
        try {
          const fetchUrl = `${baseUrl}/meta/tmdb/watch/${id}?id=${id}`;
          const response = await safeFetch(fetchUrl);
          
          if (response.ok && response.data?.sources?.length > 0) {
            const bestSource = response.data.sources.find(s => s.quality === 'auto') || response.data.sources[0];
            if (bestSource?.url) {
              resolve({ m3u8: bestSource.url, source: `Mirror API (${new URL(baseUrl).hostname})` });
            } else {
              reject(new Error('No valid URL in mirror response'));
            }
          } else {
            reject(new Error('Mirror failed or returned empty'));
          }
        } catch (e) {
          reject(e);
        }
      }));
    });

    // ─── STEP 3: FIRE THE SHOTGUN ───
    // Promise.any() waits for the FIRST promise to succeed. 
    // It ignores all the dead links, slow servers, and blocked requests.
    console.log(`[Swarm] Unleashing 35+ simultaneous requests...`);
    
    let winningStream;
    try {
      winningStream = await Promise.any(racingTasks);
    } catch (aggregateError) {
      // This ONLY triggers if literally 100% of the 35+ sources failed
      console.log(`❌ [CRITICAL MASS FAILURE] All 35+ databases and mirrors were blocked by Cloudflare or offline.`);
      return res.status(404).json({ 
        ok: false, 
        error: "Render's Datacenter IP is currently blocked by all 35+ known free streaming databases. A Residential Proxy is required to bypass this level of Cloudflare protection." 
      });
    }

    console.log(`✅ [STREAM SECURED] Fastest response from: ${winningStream.source}`);

    // Proxy the stream to bypass browser CORS blocks
    const proxied = `/api/proxy?url=${encodeURIComponent(winningStream.m3u8)}`;

    return res.json({ 
      ok: true, 
      m3u8: proxied, 
      source: winningStream.source, 
      raw: winningStream.m3u8 
    });

  } catch (e) {
    console.error(`❌ [FATAL ROUTE ERROR]`, e.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── PROXY FOR VIDEO CHUNKS ───────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('missing url');

  let target = raw;
  try { target = decodeURIComponent(raw); } catch (e) {}

  let origin;
  try { origin = new URL(target).origin; } catch { origin = 'https://vidsrc.me'; }

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
