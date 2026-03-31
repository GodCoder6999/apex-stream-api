// server.js
import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: '*' }))
app.use(express.json())

// -----------------------------
// Config
// -----------------------------
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
}

const SOURCES = [
  {
    name: 'vidsrc.xyz',
    movie: (id) => `https://vidsrc.xyz/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: 'vidsrc.me',
    movie: (id) => `https://vidsrc.me/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: '2embed.cc',
    movie: (id) => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
]

// -----------------------------
// Helpers
// -----------------------------
function withProxy(absUrl) {
  return `/api/proxy?url=${encodeURIComponent(absUrl)}`
}

function absolutize(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString()
  } catch {
    return maybeRelative
  }
}

function parseM3u8Candidates(text) {
  const out = new Set()

  // direct links in quotes
  for (const re of [
    /https?:\/\/[^"'\\\s]+\.m3u8(?:\?[^"'\\\s]*)?/gi,
    /["']([^"']+\.m3u8(?:\?[^"']*)?)["']/gi,
  ]) {
    let m
    while ((m = re.exec(text))) {
      out.add(m[1] || m[0])
    }
  }

  // common JS vars
  for (const re of [
    /(?:file|src|source|hls|playlist)\s*[:=]\s*["']([^"']+\.m3u8(?:\?[^"']*)?)["']/gi,
  ]) {
    let m
    while ((m = re.exec(text))) out.add(m[1])
  }

  return [...out]
}

function parseIframeSrcs(text) {
  const srcs = []
  const re = /<iframe[^>]+src=["']([^"']+)["']/gi
  let m
  while ((m = re.exec(text))) srcs.push(m[1])
  return srcs
}

async function fetchText(url, referer = '') {
  const origin = (() => {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  })()

  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      ...DEFAULT_HEADERS,
      ...(referer ? { Referer: referer } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
  })

  const body = await res.text()

  if (!res.ok) {
    const snippet = body.slice(0, 220).replace(/\s+/g, ' ')
    throw new Error(`HTTP ${res.status} @ ${url} | body: ${snippet}`)
  }

  return { body, finalUrl: res.url || url }
}

function isLikelyBlocked(html) {
  const s = html.toLowerCase()
  return (
    s.includes('captcha') ||
    s.includes('cloudflare') ||
    s.includes('just a moment') ||
    s.includes('access denied') ||
    s.includes('/cdn-cgi/')
  )
}

// crawl one embed page + a few iframe levels
async function resolveFromEmbed(startUrl) {
  const visited = new Set()
  const queue = [{ url: startUrl, referer: '' }]
  const MAX_HOPS = 5

  while (queue.length && visited.size < MAX_HOPS) {
    const { url, referer } = queue.shift()
    if (!url || visited.has(url)) continue
    visited.add(url)

    const { body, finalUrl } = await fetchText(url, referer)

    // quick block hint
    if (isLikelyBlocked(body)) {
      throw new Error(`Blocked/challenge page at ${finalUrl}`)
    }

    // 1) m3u8 candidates from this page
    const cands = parseM3u8Candidates(body)
      .map((c) => absolutize(finalUrl, c))
      .filter((u) => /^https?:\/\//i.test(u))

    if (cands.length) return cands[0]

    // 2) iframe drill-down
    const iframes = parseIframeSrcs(body)
      .map((s) => absolutize(finalUrl, s))
      .filter((u) => /^https?:\/\//i.test(u))

    for (const next of iframes) {
      if (!visited.has(next)) queue.push({ url: next, referer: finalUrl })
    }
  }

  throw new Error('No m3u8 found after iframe traversal')
}

// -----------------------------
// Routes
// -----------------------------
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'apex-stream-api',
    endpoints: [
      '/health',
      '/api/stream/movie/:id',
      '/api/stream/tv/:id?s=1&e=1',
      '/api/proxy?url=<encoded-url>',
    ],
  })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() })
})

app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params
  const season = Number(req.query.s || 1)
  const episode = Number(req.query.e || 1)

  if (!['movie', 'tv'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid type. Use movie or tv.' })
  }

  const failures = []

  for (const src of SOURCES) {
    try {
      const embed = type === 'movie' ? src.movie(id) : src.tv(id, season, episode)
      const m3u8 = await resolveFromEmbed(embed)

      // Return proxied URL so browser avoids CORS headaches on segment requests
      return res.json({
        ok: true,
        source: src.name,
        embed,
        m3u8: withProxy(m3u8),
      })
    } catch (err) {
      const msg = err?.message || String(err)
      failures.push({ source: src.name, error: msg })
      console.warn(`[${src.name}] ${msg}`)
    }
  }

  return res.status(404).json({
    ok: false,
    error: 'All sources failed',
    details: failures, // keep while debugging; remove later if you want
  })
})

// Generic proxy for m3u8 + ts segments
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url
  if (!raw) return res.status(400).send('missing url')

  let target
  try {
    target = decodeURIComponent(raw)
  } catch {
    target = raw
  }

  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).send('invalid url')
  }

  const origin = (() => {
    try {
      return new URL(target).origin
    } catch {
      return ''
    }
  })()

  let upstream
  try {
    upstream = await fetch(target, {
      redirect: 'follow',
      headers: {
        ...DEFAULT_HEADERS,
        ...(origin ? { Referer: `${origin}/`, Origin: origin } : {}),
      },
    })
  } catch (e) {
    return res.status(502).send(`fetch error: ${e.message}`)
  }

  if (!upstream.ok) {
    return res.status(upstream.status).send(`upstream ${upstream.status}`)
  }

  const ct = upstream.headers.get('content-type') || ''
  const isM3u8 = ct.toLowerCase().includes('mpegurl') || target.includes('.m3u8')

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (isM3u8) {
    const text = await upstream.text()
    const base = target.substring(0, target.lastIndexOf('/') + 1)

    const rewritten = text
      .split('\n')
      .map((line) => {
        const t = line.trim()
        if (!t) return line

        if (t.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
            const abs = absolutize(base, uri)
            return `URI="${withProxy(abs)}"`
          })
        }

        const abs = absolutize(base, t)
        return withProxy(abs)
      })
      .join('\n')

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.status(200).send(rewritten)
  }

  const buf = Buffer.from(await upstream.arrayBuffer())
  res.setHeader('Content-Type', ct || 'video/mp2t')
  return res.status(200).send(buf)
})

app.listen(PORT, () => {
  console.log(`✅ apex-stream-api running on :${PORT}`)
})
