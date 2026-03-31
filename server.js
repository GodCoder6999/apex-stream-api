import express from 'express';
import cors from 'cors';
import { makeProviders, makeStandardFetcher, targets } from '@movie-web/providers';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const TMDB_KEY = process.env.TMDB_KEY || 'cb1dc311039e6ae85db0aa200345cbc5';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── THE NUCLEAR ENGINE ───────────────────────────────────────────────────
// This targets exposed mobile APK databases to completely bypass Cloudflare
const providers = makeProviders({
  fetcher: makeStandardFetcher(fetch),
  target: targets.NATIVE // Tells the scrapers we are running in Node.js
});

app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const isTv = type === 'tv';

  try {
    console.log(`\n🚀 [APK BYPASS] Fetching TMDB ${id}...`);

    // 1. Get flawless metadata from TMDB
    const tmdbUrl = isTv
      ? `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}`
      : `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`;
      
    const tmdbRes = await fetch(tmdbUrl);
    if (!tmdbRes.ok) throw new Error('Failed to fetch TMDB metadata');
    const tmdbData = await tmdbRes.json();

    // 2. Format the media object exactly how the engine demands it
    const media = {
      type: isTv ? 'show' : 'movie',
      title: isTv ? tmdbData.name : tmdbData.title,
      releaseYear: isTv
        ? parseInt(tmdbData.first_air_date?.split('-')[0] || 0)
        : parseInt(tmdbData.release_date?.split('-')[0] || 0),
      tmdbId: id.toString(),
    };

    if (isTv) {
      media.episode = { number: parseInt(req.query.e || 1), tmdbId: '' };
      media.season = { number: parseInt(req.query.s || 1), tmdbId: '' };
    }

    console.log(`[Engine] Searching mobile databases for: ${media.title} (${media.releaseYear})`);

    // 3. FIRE THE ENGINE: It automatically searches 20+ unlocked databases
    const result = await providers.runAll({ media });

    if (!result || !result.stream) {
      return res.status(404).json({ ok: false, error: 'No raw streams found across any unlocked database.' });
    }

    // 4. Extract the raw m3u8 or mp4 link
    let rawM3u8 = '';
    if (result.stream.type === 'hls') {
      rawM3u8 = result.stream.playlist;
    } else if (result.stream.type === 'file') {
      // If it's a raw mp4, grab the highest quality available
      const qualities = Object.values(result.stream.qualities);
      rawM3u8 = qualities[0]?.url;
    }

    if (!rawM3u8) throw new Error('Failed to parse stream URL from engine output.');

    console.log(`✅ [SUCCESS] -> Found raw stream via ${result.providerId}`);

    // 5. Proxy the winning stream to bypass browser CORS constraints
    const proxied = `/api/proxy?url=${encodeURIComponent(rawM3u8)}`;

    return res.json({ 
      ok: true, 
      m3u8: proxied, 
      source: `App Database (${result.providerId})`, 
      raw: rawM3u8 
    });

  } catch (e) {
    console.error(`❌ [FAILED]`, e.message);
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
