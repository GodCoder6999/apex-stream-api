import express from 'express';
import cors from 'cors';
import { MOVIES } from '@consumet/extensions';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TMDB_KEY = process.env.TMDB_KEY || 'cb1dc311039e6ae85db0aa200345cbc5';

// ─── MASSIVE LIST OF PUBLIC API MIRRORS ───────────────────────────────────
// These are community-hosted Consumet APIs. If the main one is down, others usually work.
const PUBLIC_MIRRORS = [
  'https://api.consumet.org',
  'https://consumet-api.herokuapp.com',
  'https://c.delusionz.xyz',
  'https://api.anify.tv',
  'https://consumet-api-production-e544.up.railway.app',
  'https://api.streamm.tv',
  'https://consumet-api.onrender.com',
  'https://consumet.vercel.app'
];

// ─── NATIVE SCRAPERS ──────────────────────────────────────────────────────
const NATIVE_PROVIDERS = [
  { name: 'FlixHQ', client: new MOVIES.FlixHQ() },
  { name: 'SFlix', client: new MOVIES.SFlix() },
  { name: 'Goku', client: new MOVIES.Goku() },
  { name: 'ZoeChip', client: new MOVIES.ZoeChip() },
  { name: 'VidSrcTo', client: new MOVIES.VidSrcTo() },
  { name: 'MovieHdWatch', client: new MOVIES.MovieHdWatch() }
];

// ─── THE SHOTGUN AGGREGATOR ENGINE ────────────────────────────────────────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const season = parseInt(req.query.s || '1', 10);
  const episode = parseInt(req.query.e || '1', 10);

  console.log(`\n🚀 [SHOTGUN START] Fetching TMDB ${id} (${type})...`);

  try {
    // 1. Get exact Title & Year from TMDB for native scrapers
    const tmdbUrl = type === 'movie'
      ? `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`
      : `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}`;

    const tmdbRes = await fetch(tmdbUrl);
    if (!tmdbRes.ok) throw new Error('Failed to fetch TMDB metadata');
    const tmdbData = await tmdbRes.json();

    const title = type === 'movie' ? tmdbData.title : tmdbData.name;
    const year = type === 'movie' ? tmdbData.release_date?.split('-')[0] : tmdbData.first_air_date?.split('-')[0];

    // 2. Build the massive array of racing promises
    const racingTasks = [];

    // --- STRATEGY A: Query all 8+ Public Mirrors simultaneously ---
    PUBLIC_MIRRORS.forEach(baseUrl => {
      racingTasks.push(new Promise(async (resolve, reject) => {
        try {
          const infoUrl = `${baseUrl}/meta/tmdb/info/${id}?type=${type}`;
          const infoRes = await fetch(infoUrl, { signal: AbortSignal.timeout(8000) });
          if (!infoRes.ok) throw new Error('Info failed');
          const info = await infoRes.json();

          let watchId = info.episodeId || info.id;
          if (type === 'tv' && info.episodes) {
            const ep = info.episodes.find(e => e.season === season && e.number === episode);
            if (ep) watchId = ep.id;
          }

          const watchUrl = `${baseUrl}/meta/tmdb/watch/${watchId}?id=${id}`;
          const watchRes = await fetch(watchUrl, { signal: AbortSignal.timeout(8000) });
          if (!watchRes.ok) throw new Error('Watch failed');
          const watch = await watchRes.json();

          if (!watch.sources || watch.sources.length === 0) throw new Error('No sources');
          
          const best = watch.sources.find(s => s.quality === 'auto') || watch.sources[0];
          resolve({ m3u8: best.url, source: `Mirror API (${baseUrl})` });
        } catch (e) {
          reject(e); // Reject silently so Promise.any keeps searching other providers
        }
      }));
    });

    // --- STRATEGY B: Run all 6+ Native Scrapers simultaneously ---
    NATIVE_PROVIDERS.forEach(provider => {
      racingTasks.push(new Promise(async (resolve, reject) => {
        try {
          const search = await provider.client.search(title);
          if (!search.results || search.results.length === 0) throw new Error('No search results');

          let match = search.results.find(r => r.releaseDate === year || r.year === year) || search.results[0];
          
          const info = await provider.client.fetchMediaInfo(match.id);
          if (!info) throw new Error('No media info');

          let watchId = info.id;
          if (type === 'tv' && info.episodes) {
            const ep = info.episodes.find(e => e.season === season && e.number === episode);
            if (!ep) throw new Error('Episode not found');
            watchId = ep.id;
          } else if (info.episodes && info.episodes.length > 0) {
            watchId = info.episodes[0].id;
          }

          const sources = await provider.client.fetchEpisodeSources(watchId, info.id);
          if (!sources || !sources.sources || sources.sources.length === 0) throw new Error('No sources');

          const best = sources.sources.find(s => s.quality === 'auto') || sources.sources[0];
          resolve({ m3u8: best.url, source: `Native Scraper (${provider.name})` });
        } catch (e) {
          reject(e); // Reject silently so Promise.any keeps searching other providers
        }
      }));
    });

    // 3. FIRE THE SHOTGUN: The first Promise to resolve (find an m3u8) wins.
    // If every single one of the 14+ tasks fails, it falls into the catch block.
    const winner = await Promise.any(racingTasks);

    console.log(`✅ [SHOTGUN WINNER] -> Found stream via ${winner.source}`);
    
    // 4. Proxy the winning stream to bypass browser CORS constraints
    const proxied = `/api/proxy?url=${encodeURIComponent(winner.m3u8)}`;
    
    return res.json({ ok: true, m3u8: proxied, source: winner.source, raw: winner.m3u8 });

  } catch (aggregateError) {
    // This only triggers if literally 100% of the racing promises failed
    console.error('❌ [SHOTGUN FAILED] Every single provider and mirror was blocked or offline.');
    res.status(502).json({ 
      ok: false, 
      error: 'Aggregator failed. All 25+ sources and mirrors are currently offline or actively blocking Render\'s datacenter IPs.' 
    });
  }
});

// ─── PROXY FOR VIDEO CHUNKS (Unchanged) ───────────────────────────────────
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
