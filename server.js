// ─────────────────────────────────────────────────────────────────────────────
// apex-stream-api  — Express backend deployed on Render (free tier)
//
// Two jobs:
//  1. /api/stream/:type/:id   →  scrape embed pages, return a proxied m3u8 URL
//  2. /api/proxy              →  CORS proxy for all m3u8 + ts segment requests
//
// Deploy this to Render.com (free web service, Node 18+).
// Your Vite/Vercel frontend calls this backend.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express'
import cors    from 'cors'
import fetch   from 'node-fetch'

const app  = express()
const PORT = process.env.PORT || 3001

// Allow requests from any origin (your Vercel frontend)
app.use(cors({ origin: '*' }))

// ─── USER-AGENT shared across all requests ───────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ─── EMBED SOURCES ───────────────────────────────────────────────────────────
// These pages embed a player that loads a raw .m3u8.
// We fetch the page HTML server-side and extract the URL.
const SOURCES = [
  {
    id: 'vidsrc-cc',
    label: 'VidSrc CC',
    movie: (id)       => `https://vidsrc.cc/v2/embed/movie/${id}`,
    tv:    (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc-xyz',
    label: 'VidSrc XYZ',
    movie: (id)       => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    tv:    (id, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    id: 'vidsrc-me',
    label: 'VidSrc ME',
    movie: (id)       => `https://vidsrc.me/embed/movie?tmdb=${id}`,
    tv:    (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    id: 'autoembed',
    label: 'AutoEmbed',
    movie: (id)       => `https://player.autoembed.cc/embed/movie/${id}`,
    tv:    (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'embed-su',
    label: 'Embed SU',
    movie: (id)       => `https://embed.su/embed/movie/${id}`,
    tv:    (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: '2embed',
    label: '2Embed',
    movie: (id)       => `https://www.2embed.cc/embed/${id}`,
    tv:    (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    id: 'multiembed',
    label: 'MultiEmbed',
    movie: (id)       => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`,
    tv:    (id, s, e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
]

// ─── EXTRACT M3U8 FROM AN EMBED PAGE ─────────────────────────────────────────
// The embed page HTML always contains the m3u8 URL in a JS variable or
// data attribute. We fetch the page and regex-extract it.
// If the first-level page has an <iframe>, we follow it one level deep.

const M3U8_RE = [
  /["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/g,
  /file\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /source\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /src\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /url\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /stream\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /hls\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /(https?:\/\/[^\s"'<>{}|\\^[\]`]+\.m3u8[^\s"'<>{}|\\^[\]`]*)/g,
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
      if (/ads?[._-]|track|beacon|analytics|doubleclick|googletag/i.test(u)) continue
      hits.push(u)
    }
  }
  // Longer URLs are usually the actual CDN stream (not an ad placeholder)
  hits.sort((a, b) => b.length - a.length)
  return hits[0] || null
}

// Extract iframes from HTML, return absolute src URLs
function extractIframeSrcs(html, pageUrl) {
  const srcs = []
  const re = /<iframe[^>]+src=["']([^"']+)/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim()
    if (!src || src === 'about:blank') continue
    try {
      srcs.push(new URL(src, pageUrl).href)
    } catch {}
  }
  return srcs
}

async function fetchHtml(url, referer) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer:      referer || url,
      Origin:       new URL(url).origin,
      Accept:       'text/html,application/xhtml+xml,*/*',
    },
    redirect: 'follow',
    signal:   AbortSignal.timeout(12000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

async function resolveSource(source, type, id, season = 1, episode = 1) {
  const embedUrl = type === 'tv' ? source.tv(id, season, episode) : source.movie(id)

  // --- Level 1: fetch embed page ---
  let html
  try {
    html = await fetchHtml(embedUrl, 'https://www.google.com/')
  } catch (e) {
    throw new Error(`page fetch failed: ${e.message}`)
  }

  // Try to find m3u8 directly in the embed page
  let m3u8 = extractM3u8FromHtml(html)
  if (m3u8) return { m3u8, source: source.label }

  // --- Level 2: follow iframes ---
  const iframes = extractIframeSrcs(html, embedUrl)
  for (const iframeSrc of iframes.slice(0, 4)) {
    try {
      const iframeHtml = await fetchHtml(iframeSrc, embedUrl)
      m3u8 = extractM3u8FromHtml(iframeHtml)
      if (m3u8) return { m3u8, source: source.label }

      // Level 3: iframes inside iframes (some providers nest 2 deep)
      const nested = extractIframeSrcs(iframeHtml, iframeSrc)
      for (const nestedSrc of nested.slice(0, 3)) {
        try {
          const nestedHtml = await fetchHtml(nestedSrc, iframeSrc)
          m3u8 = extractM3u8FromHtml(nestedHtml)
          if (m3u8) return { m3u8, source: source.label }
        } catch {}
      }
    } catch {}
  }

  throw new Error('no m3u8 found')
}

// ─── /api/stream/:type/:id ────────────────────────────────────────────────────
// Returns: { m3u8: "/api/proxy?url=...", source: "VidSrc CC" }
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params
  const season  = parseInt(req.query.s  || '1', 10)
  const episode = parseInt(req.query.e  || '1', 10)

  for (const source of SOURCES) {
    try {
      const result = await resolveSource(source, type, id, season, episode)
      // Wrap through our proxy so the browser never hits CDN directly
      const proxied = `/api/proxy?url=${encodeURIComponent(result.m3u8)}`
      console.log(`[${source.label}] ✓ ${id} → ${result.m3u8.substring(0, 80)}…`)
      return res.json({ ok: true, m3u8: proxied, source: result.source, raw: result.m3u8 })
    } catch (e) {
      console.warn(`[${source.label}] ✗ ${id}: ${e.message}`)
    }
  }

  res.status(404).json({ ok: false, error: 'All sources failed' })
})

// ─── /api/proxy ───────────────────────────────────────────────────────────────
// Proxies m3u8 manifests (rewriting internal URLs) and binary .ts segments.
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url
  if (!raw) return res.status(400).send('missing url')

  const target = decodeURIComponent(raw)
  let origin
  try { origin = new URL(target).origin } catch { origin = 'https://vidsrc.me' }

  let upstream
  try {
    upstream = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Referer:      origin + '/',
        Origin:       origin,
        Accept:       '*/*',
      },
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    return res.status(502).send(`fetch error: ${e.message}`)
  }

  if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`)

  const ct = upstream.headers.get('content-type') || ''
  const isM3u8 = ct.includes('mpegurl') || target.includes('.m3u8')

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (isM3u8) {
    const text = await upstream.text()
    const base = target.substring(0, target.lastIndexOf('/') + 1)
    const rewritten = rewriteManifest(text, base, req)
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.send(rewritten)
  }

  // Binary segment
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