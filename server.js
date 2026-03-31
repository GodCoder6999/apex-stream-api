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
const providers = makeProviders({
  fetcher: makeStandardFetcher(fetch),
  // FIX: Changed from NATIVE to ANY. 
  // NATIVE filtered out 95% of the databases. ANY runs all 20+ scrapers.
  target: targets.ANY 
});

app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const isTv = type === 'tv';

  try {
    console.log(`\n🚀 [APK BYPASS] Fetching Metadata for ${id}...`);

    const tmdbUrl = isTv
      ? `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids`
      : `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids`;
      
    const tmdbRes = await fetch(tmdbUrl);
    if (!tmdbRes.ok) throw new Error('Failed to fetch TMDB metadata');
    const tmdbData = await tmdbRes.json();

    const extractedImdbId = tmdbData.external_ids?.imdb_id || tmdbData.imdb_id || '';

    const media = {
      type: isTv ? 'show' : 'movie',
      title: isTv ? tmdbData.name : tmdbData.title,
      releaseYear: isTv
        ? parseInt(tmdbData.first_air_date?.split('-')[0] || 0)
        : parseInt(tmdbData.release_date?.split('-')[0] || 0),
      tmdbId: id.toString(),
      imdbId: extractedImdbId,
    };

    if (isTv) {
      media.episode = { number: parseInt(req.query.e || 1), tmdbId: '' };
      media.season = { number: parseInt(req.query.s || 1), tmdbId: '' };
    }

    console.log(`[Engine] Searching ALL databases for: ${media.title} (${media.releaseYear}) | IMDB: ${media.imdbId}`);

    // Run all 20+ scrapers
    const result = await providers.runAll({ media });

    let rawM3u8 = '';
    let sourceName = '';

    if (result && result.stream) {
      if (result.stream.type === 'hls') {
        rawM3u8 = result.stream.playlist;
      } else if (result.stream.type === 'file') {
        const qualities = Object.values(result.stream.qualities);
        rawM3u8 = qualities[0]?.url;
      }
      sourceName = `App Database (${result.providerId})`;
    } 
    
    // LAYER 2 FALLBACK: If movie-web somehow fails, use a secondary unblocked community API
    if (!rawM3u8) {
        console.log(`⚠️ Engine yielded no results. Triggering Layer 2 Community Fallback...`);
        const fallbackRes = await fetch(`https://api.streamm.tv/meta/tmdb/watch/${id}?id=${id}`);
        if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json();
            const bestSource = fallbackData.sources?.find(s => s.quality === 'auto') || fallbackData.sources?.[0];
            if (bestSource) {
                rawM3u8 = bestSource.url;
                sourceName = 'StreammTV Fallback';
            }
        }
    }

    if (!rawM3u8) {
        throw new Error('Failed to extract raw stream from all primary and fallback databases.');
    }

    console.log(`✅ [SUCCESS] -> Found raw stream via ${sourceName}`);

    // Proxy the stream to bypass browser CORS blocks
    const proxied = `/api/proxy?url=${encodeURIComponent(rawM3u8)}`;

    return res.json({ 
      ok: true, 
      m3u8: proxied, 
      source: sourceName, 
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
