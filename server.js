import express from 'express';
import cors from 'cors';
import { MOVIES } from '@consumet/extensions';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Using the TMDB API key from your environment to fetch exact titles
const TMDB_KEY = process.env.TMDB_KEY || 'cb1dc311039e6ae85db0aa200345cbc5';

// ─── THE FALLBACK AGGREGATOR ──────────────────────────────────────────────
// If one site throws a 521 (Down) or 403 (Blocked), it moves to the next.
const providers = [
  { name: 'FlixHQ', client: new MOVIES.FlixHQ() },
  { name: 'SFlix',  client: new MOVIES.SFlix() },
  { name: 'Goku',   client: new MOVIES.Goku() }
];

app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const season = parseInt(req.query.s || '1', 10);
  const episode = parseInt(req.query.e || '1', 10);

  try {
    console.log(`[Search] Resolving TMDB ID: ${id}...`);
    
    // 1. Get exact Title and Year from TMDB
    const tmdbUrl = type === 'movie'
      ? `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`
      : `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}`;

    const tmdbRes = await fetch(tmdbUrl);
    if (!tmdbRes.ok) throw new Error('Failed to fetch TMDB metadata');
    const tmdbData = await tmdbRes.json();

    const title = type === 'movie' ? tmdbData.title : tmdbData.name;
    const year = type === 'movie'
      ? tmdbData.release_date?.split('-')[0]
      : tmdbData.first_air_date?.split('-')[0];

    // 2. Iterate through providers until one successfully returns an m3u8
    for (const provider of providers) {
      try {
        console.log(`[Consumet] Trying provider: ${provider.name}...`);

        // Search the provider by title
        const searchResults = await provider.client.search(title);
        if (!searchResults.results || searchResults.results.length === 0) continue;

        // Try to match the exact release year to avoid playing the wrong movie
        let match = searchResults.results.find(r => r.releaseDate === year || r.year === year);
        if (!match) match = searchResults.results[0]; 

        // Get Media Info & Episodes
        const mediaInfo = await provider.client.fetchMediaInfo(match.id);
        if (!mediaInfo) continue;

        let watchId = mediaInfo.id;
        if (type === 'tv' && mediaInfo.episodes) {
          const ep = mediaInfo.episodes.find(e => e.season === season && e.number === episode);
          if (!ep) continue;
          watchId = ep.id;
        } else if (mediaInfo.episodes && mediaInfo.episodes.length > 0) {
          watchId = mediaInfo.episodes[0].id;
        }

        // Extract the raw m3u8 link
        const sources = await provider.client.fetchEpisodeSources(watchId, mediaInfo.id);
        if (!sources || !sources.sources || sources.sources.length === 0) continue;

        const bestSource = sources.sources.find(s => s.quality === 'auto') || sources.sources[0];
        const rawM3u8 = bestSource.url;

        // Proxy the chunks to bypass browser CORS
        const proxied = `/api/proxy?url=${encodeURIComponent(rawM3u8)}`;

        console.log(`[Consumet] ✅ Success via ${provider.name}`);
        return res.json({ ok: true, m3u8: proxied, source: provider.name, raw: rawM3u8 });

      } catch (e) {
        // If a provider fails (e.g. 521 Server Down), catch the error silently and loop to the next one
        console.warn(`[Consumet] ⚠️ ${provider.name} failed: ${e.message}`);
      }
    }

    res.status(404).json({ ok: false, error: 'All streaming providers failed or are offline.' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
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
      headers: {
        'User-Agent': UA,
        Referer: origin + '/',
        Origin: origin,
        Accept: '*/*'
      },
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
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) =>
        `URI="${proxyBase}${encodeURIComponent(toAbs(uri, base))}"`);
    }
    return proxyBase + encodeURIComponent(toAbs(t, base));
  }).join('\n');
}

function toAbs(url, base) {
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    try { return new URL(base).origin + url; } catch {}
  }
  return base + url;
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`apex-stream-api running on :${PORT}`));
