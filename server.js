// ─────────────────────────────────────────────────────────────────────────────
// apex-stream-api  — Express backend deployed on Render (free tier)
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express'
import cors    from 'cors'
import { ProxyAgent } from 'undici' // Node's native fetch handler

const app  = express()
const PORT = process.env.PORT || 3001

app.set('trust proxy', true)
app.use(cors({ origin: '*' }))

// ─── PROXY CONFIGURATION ─────────────────────────────────────────────────────
// Reads the proxy URL from Render's environment variables
const proxyString = process.env.PROXY_URL
const proxyAgent = proxyString ? new ProxyAgent(proxyString) : null

if (proxyAgent) {
  console.log('✅ Residential Proxy Agent loaded.')
} else {
  console.log('⚠️ No PROXY_URL found. Running with datacenter IP (may get blocked).')
}

// ─── USER-AGENT shared across all requests ───────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ─── EMBED SOURCES ───────────────────────────────────────────────────────────
const SOURCES = [
  {
    id: 'vidsrc-me',
    label: 'VidSrc ME',
    movie: (id)       => `https://vidsrc.me/embed/movie?tmdb=${id}`,
    tv:    (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    id: 'vidsrc-cc',
    label: 'VidSrc CC',
    movie: (id)       => `https://vidsrc.cc/v2/embed/movie/${id}`,
    tv:    (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'autoembed',
    label: 'AutoEmbed',
    movie: (id)       => `https://player.autoembed.cc/embed/movie/${id}`,
    tv:    (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: '2embed',
    label: '2Embed',
    movie: (id)       => `https://www.2embed.cc/embed/${id}`,
    tv:    (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  }
]

// ─── EXTRACT M3U8 FROM AN EMBED PAGE ─────────────────────────────────────────
const M3U8_RE = [
  /["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/g,
  /file\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /source\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /src\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
]

function extractM3u8FromHtml(html) {
  const seen = new Set()
  const hits = []
  for (const re of M3U8_RE) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(html)) !== null) {
      const u = m[1]
      if (!u || seen.has(u)) continue
      seen.add(u)
      if (/ads?[._-]|track|beacon|analytics/i.test(u)) continue
      hits.push(u)
    }
  }
  hits.sort((a, b) => b.length - a.length)
  return hits[0] || null
}

function extractIframeSrcs(html, pageUrl) {
  const srcs = []
  const re = /<iframe[^>]+src=["']([^"']+)/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim()
    if (!src || src === 'about:blank') continue
    try { srcs.push(new URL(src, pageUrl).href) } catch {}
  }
  return srcs
}

async function fetchHtml(url, referer) {
  const fetchOptions = {
    headers: {
      'User-Agent': UA,
      Referer:      referer || url,
      Origin:       new URL(url).origin,
      Accept:       'text/html,application/xhtml+xml,*/*',
    },
    redirect: 'follow',
    signal:   AbortSignal.timeout(12000),
  }
  
  // Attach the residential proxy if configured
  if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

  const resp = await fetch(url, fetchOptions)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

async function resolveSource(source, type, id, season = 1, episode = 1) {
  const embedUrl = type === 'tv' ? source.tv(id, season, episode) : source.movie(id)

  let html
  try {
    html = await fetchHtml(embedUrl, 'https://www.google.com/')
  } catch (e) {
    throw new Error(`page fetch failed: ${e.message}`)
  }

  let m3u8 = extractM3u8FromHtml(html)
  if (m3u8) return { m3u8, source: source.label }

  const iframes = extractIframeSrcs(html, embedUrl)
  for (const iframeSrc of iframes.slice(0, 3)) {
    try {
      const iframeHtml = await fetchHtml(iframeSrc, embedUrl)
      m3u8 = extractM3u8FromHtml(iframeHtml)
      if (m3u8) return { m3u8, source: source.label }
    } catch {}
  }
  throw new Error('no m3u8 found')
}

// ─── /api/stream/:type/:id ────────────────────────────────────────────────────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params
  const season  = parseInt(req.query.s  || '1', 10)
  const episode = parseInt(req.query.e  || '1', 10)

  for (const source of SOURCES) {
    try {
      const result = await resolveSource(source, type, id, season, episode)
      const proxied = `/api/proxy?url=${encodeURIComponent(result.m3u8)}`
      console.log(`[${source.label}] ✓ ${id} → Success`)
      return res.json({ ok: true, m3u8: proxied, source: result.source, raw: result.m3u8 })
    } catch (e) {
      console.warn(`[${source.label}] ✗ ${id}: ${e.message}`)
    }
  }

  res.status(404).json({ ok: false, error: 'All sources failed' })
})

// ─── /api/proxy ───────────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url
  if (!raw) return res.status(400).send('missing url')

  let target = raw
  try { target = decodeURIComponent(raw) } catch(e) {}

  let origin
  try { origin = new URL(target).origin } catch { origin = 'https://vidsrc.me' }

  const fetchOptions = {
    headers: {
      'User-Agent': UA,
      Referer:      origin + '/',
      Origin:       origin,
      Accept:       '*/*',
    },
    signal: AbortSignal.timeout(15000),
  }

  // Attach the residential proxy for streaming chunks too
  if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

  let upstream
  try {
    upstream = await fetch(target, fetchOptions)
  } catch (e) {
    return res.status(502).send(`fetch error: ${e.message}`)
  }

  if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`)

  const ct = upstream.headers.get('content-type') || ''
  const isM3u8 = ct.toLowerCase().includes('mpegurl') || target.includes('.m3u8')

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (isM3u8) {
    const text = await upstream.text()
    const base = target.substring(0, target.lastIndexOf('/') + 1)
    const rewritten = rewriteManifest(text, base, req)
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.send(rewritten)
  }

  const buf = Buffer.from(await upstream.arrayBuffer())
  res.setHeader('Content-Type', ct || 'video/mp2t')
  return res.send(buf)
})

// ─── MANIFEST REWRITER ────────────────────────────────────────────────────────
function rewriteManifest(text, base, req) {
  const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?url=`
  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) =>
        `URI="${proxyBase}${encodeURIComponent(toAbs(uri, base))}"`)
    }
    return proxyBase + encodeURIComponent(toAbs(t, base))
  }).join('\n')
}

function toAbs(url, base) {
  if (url.startsWith('http')) return url
  if (url.startsWith('//')) return 'https:' + url
  if (url.startsWith('/')) {
    try { return new URL(base).origin + url } catch {}
  }
  return base + url
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`apex-stream-api running on :${PORT}`))
