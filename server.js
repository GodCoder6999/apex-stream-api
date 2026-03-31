import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors({ origin: '*' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── CONSUMET API INTEGRATION ─────────────────────────────────────────────
// Executed server-side to completely bypass the browser's CORS blocks
const CONSUMET_INSTANCES = [
  'https://api.consumet.org',
  'https://consumet-api.herokuapp.com'
];

async function fetchFromConsumet(endpoint) {
  for (const baseUrl of CONSUMET_INSTANCES) {
    try {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.warn(`[Consumet] Failed on ${baseUrl}: ${e.message}`);
    }
  }
  throw new Error('All Consumet streaming instances failed or are offline.');
}

app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const season = parseInt(req.query.s || '1', 10);
  const episode = parseInt(req.query.e || '1', 10);

  try {
    console.log(`[Consumet] Fetching ${type} ${id}...`);
    
    // 1. Get Media Info
    const infoData = await fetchFromConsumet(`/meta/tmdb/info/${id}?type=${type}`);
    if (!infoData || (!infoData.id && !infoData.episodeId)) {
      return res.status(404).json({ ok: false, error: 'Media not found on streaming servers' });
    }

    // 2. Find correct episode ID for TV shows
    let watchId = infoData.episodeId || infoData.id;
    if (type === 'tv' && infoData.episodes) {
      const ep = infoData.episodes.find(e => e.season === season && e.number === episode);
      if (ep) watchId = ep.id;
    }

    // 3. Get Streaming Links
    const watchData = await fetchFromConsumet(`/meta/tmdb/watch/${watchId}?id=${id}`);
    if (!watchData.sources || watchData.sources.length === 0) {
      return res.status(404).json({ ok: false, error: 'No playable sources found' });
    }

    // 4. Select the best m3u8 stream
    const bestSource = watchData.sources.find(s => s.quality === 'auto') || watchData.sources[0];
    const rawM3u8 = bestSource.url;

    // 5. Proxy the m3u8 so the frontend doesn't crash on video chunks
    const proxied = `/api/proxy?url=${encodeURIComponent(rawM3u8)}`;

    res.json({ ok: true, m3u8: proxied, source: 'Consumet API', raw: rawM3u8 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── PROXY FOR VIDEO CHUNKS ───────────────────────────────────────────────
// Forces hls.js to download chunks through Render, bypassing stream protections
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
