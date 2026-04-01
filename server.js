// ─────────────────────────────────────────────────────────────────────────────
// apex-stream-api  —  Render.com Express backend
//
// METHOD 1 (PRIMARY): vidsrc.xyz RCP chain
//   vidsrc.xyz/embed → parse servers list → fetch /rcp/{dataHash} →
//   fetch BASEDOM/prorcp/{id} → decrypt → m3u8
//
// METHOD 2 (FALLBACK): SoaperTV POST API
//   TMDB title → soaper.cc/search → #hId → POST getMInfoAjax → val = stream
//
// METHOD 3 (LAST RESORT): vidsrc.cc / autoembed HTML scan
//
// All results proxied through /api/proxy for CORS
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express'
import cors    from 'cors'
import fetch   from 'node-fetch'

const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: '*' }))
app.use(express.json())

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TMDB_KEY = process.env.TMDB_KEY || 'cb1dc311039e6ae85db0aa200345cbc5'

// ─── In-memory cache (TTL: 15 min) ───────────────────────────────────────────
const cache = new Map()
function getCache(key) {
  const e = cache.get(key)
  if (!e) return null
  if (Date.now() > e.exp) { cache.delete(key); return null }
  return e.val
}
function setCache(key, val, ttlMs = 15 * 60 * 1000) {
  cache.set(key, { val, exp: Date.now() + ttlMs })
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────
async function get(url, headers = {}, timeoutMs = 15000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`)
  return resp
}

async function getText(url, headers = {}) {
  return (await get(url, headers)).text()
}

// ─── DECODER (ported from vidsrc.ts decoder.ts) ───────────────────────────────
// These are the 12 known decryption algorithms used by whisperingauroras.com
function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function LXVUMCoAHJ(data) {
  try {
    const rev  = data.split('').reverse().join('')
    const dec  = decodeBase64(rev)
    return dec.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 3)).join('')
  } catch { return null }
}

function GuxKGDsA2T(data) {
  try {
    const rev  = data.split('').reverse().join('')
    const dec  = decodeBase64(rev)
    return dec.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 7)).join('')
  } catch { return null }
}

function laM1dAi3vO(data) {
  try {
    const rev  = data.split('').reverse().join('')
    const dec  = decodeBase64(rev)
    return dec.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 5)).join('')
  } catch { return null }
}

function Iry9MQXnLs(data, key) {
  try {
    const hexDecoded = Buffer.from(data, 'hex').toString('utf8')
    const reversed   = hexDecoded.split('').reverse().join('')
    let xored = ''
    for (let i = 0; i < reversed.length; i++) {
      xored += String.fromCharCode(reversed.charCodeAt(i) ^ key.charCodeAt(i % key.length))
    }
    const shifted = xored.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 3)).join('')
    return decodeBase64(shifted)
  } catch { return null }
}

function C66jPHx8qu(data, key) {
  try {
    const rev  = data.split('').reverse().join('')
    const hex  = Buffer.from(rev, 'hex').toString('utf8')
    let result = ''
    for (let i = 0; i < hex.length; i++) {
      result += String.fromCharCode(hex.charCodeAt(i) ^ key.charCodeAt(i % key.length))
    }
    return result
  } catch { return null }
}

function detdj7JHiK(data, key) {
  try {
    const sliced = data.slice(2)
    const dec    = decodeBase64(sliced)
    let result   = ''
    const rKey   = key.repeat(Math.ceil(dec.length / key.length)).slice(0, dec.length)
    for (let i = 0; i < dec.length; i++) {
      result += String.fromCharCode(dec.charCodeAt(i) ^ rKey.charCodeAt(i))
    }
    return result
  } catch { return null }
}

function nZlUnj2VSo(data) {
  try {
    const map = {'a':'n','b':'o','c':'p','d':'q','e':'r','f':'s','g':'t','h':'u','i':'v','j':'w','k':'x','l':'y','m':'z','n':'a','o':'b','p':'c','q':'d','r':'e','s':'f','t':'g','u':'h','v':'i','w':'j','x':'k','y':'l','z':'m','A':'N','B':'O','C':'P','D':'Q','E':'R','F':'S','G':'T','H':'U','I':'V','J':'W','K':'X','L':'Y','M':'Z','N':'A','O':'B','P':'C','Q':'D','R':'E','S':'F','T':'G','U':'H','V':'I','W':'J','X':'K','Y':'L','Z':'M'}
    return data.split('').map(c => map[c] || c).join('')
  } catch { return null }
}

function IGLImMhWrI(data) {
  try {
    const rev1   = data.split('').reverse().join('')
    const rot13  = rev1.split('').map(c => {
      if (c >= 'a' && c <= 'z') return String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)
      if (c >= 'A' && c <= 'Z') return String.fromCharCode(((c.charCodeAt(0) - 65 + 13) % 26) + 65)
      return c
    }).join('')
    const rev2 = rot13.split('').reverse().join('')
    return decodeBase64(rev2)
  } catch { return null }
}

function GTAxQyTyBx(data) {
  try {
    const rev    = data.split('').reverse().join('')
    const evens  = rev.split('').filter((_, i) => i % 2 === 0).join('')
    return decodeBase64(evens)
  } catch { return null }
}

function MyL1IRSfHe(data) {
  try {
    const rev     = data.split('').reverse().join('')
    const shifted = rev.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 5)).join('')
    return Buffer.from(shifted, 'hex').toString('utf8')
  } catch { return null }
}

function decrypt(fnName, data, key) {
  console.log(`[decrypt] fn=${fnName} key=${key}`)
  const fns = { LXVUMCoAHJ, GuxKGDsA2T, laM1dAi3vO, Iry9MQXnLs, C66jPHx8qu, detdj7JHiK, nZlUnj2VSo, IGLImMhWrI, GTAxQyTyBx, MyL1IRSfHe }
  const fn  = fns[fnName]
  if (!fn) {
    console.warn(`[decrypt] Unknown function: ${fnName}`)
    return null
  }
  // Some fns take key, some don't
  return fn.length === 2 ? fn(data, key) : fn(data)
}

// ─────────────────────────────────────────────────────────────────────────────
// METHOD 1: vidsrc.xyz RCP chain
// ─────────────────────────────────────────────────────────────────────────────

let BASEDOM = 'https://cloudnestra.com'

// Step 1: Fetch embed page, extract server list + detect BASEDOM from iframe
async function serversLoad(embedUrl) {
  const html = await getText(embedUrl, {
    Referer: 'https://vidsrc.xyz/',
    Origin:  'https://vidsrc.xyz',
  })

  // Detect BASEDOM from iframe src
  const iframeMatch = html.match(/iframe[^>]+src=["']([^"']+)/i)
  if (iframeMatch) {
    try {
      BASEDOM = new URL(iframeMatch[1]).origin
      console.log(`[vidsrc] BASEDOM detected: ${BASEDOM}`)
    } catch {
      const m = iframeMatch[1].match(/(https?:\/\/[^/]+)/)
      if (m) BASEDOM = m[1]
    }
  }

  // Parse server list: <div class="server" data-hash="xxx">
  const servers = []
  const serverRe = /data-hash=["']([^"']+)["'][^>]*>([^<]*)/gi
  let m
  while ((m = serverRe.exec(html)) !== null) {
    servers.push({ dataHash: m[1], name: m[2].trim() || 'Server' })
  }

  // Fallback: match any data-hash
  if (servers.length === 0) {
    const fallbackRe = /data-hash=["']([^"']+)["']/gi
    while ((m = fallbackRe.exec(html)) !== null) {
      servers.push({ dataHash: m[1], name: 'Server' })
    }
  }

  console.log(`[vidsrc] Found ${servers.length} servers from ${embedUrl}`)
  return servers
}

// Step 2: Fetch /rcp/{dataHash} → extract src field
async function rcpGrabber(dataHash) {
  const url  = `${BASEDOM}/rcp/${dataHash}`
  const html = await getText(url, {
    Referer: BASEDOM + '/',
    Origin:  BASEDOM,
  })

  // Pattern: src: 'xxxxx' or source:'xxxxx'
  const m = html.match(/src\s*:\s*['"]([^'"]+)['"]/i)
                || html.match(/source\s*:\s*['"]([^'"]+)['"]/i)
                || html.match(/file\s*:\s*['"]([^'"]+)['"]/i)
  if (!m) {
    console.warn(`[vidsrc] No src found in rcp page for hash ${dataHash}`)
    return null
  }
  return { src: m[1], dataHash }
}

// Step 3: PRORCPhandler — fetch prorcp page, get JS file, decrypt URL
async function prorcpHandler(src) {
  const proUrl = `${BASEDOM}/prorcp/${src}`
  const html   = await getText(proUrl, {
    Referer: BASEDOM + '/',
    Origin:  BASEDOM,
  })

  // Find JS script files (exclude cpt.js)
  const scriptMatches = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)]
  const scripts = scriptMatches
    .map(m => m[1])
    .filter(s => !s.includes('cpt.js'))

  if (!scripts.length) {
    console.warn('[vidsrc] No JS scripts found in prorcp page')
    return null
  }

  // Use last script (most likely the decryption one)
  let scriptUrl = scripts[scripts.length - 1]
  if (!scriptUrl.startsWith('http')) {
    scriptUrl = BASEDOM + scriptUrl
  }

  const jsCode = await getText(scriptUrl, { Referer: proUrl })

  // Extract: {}window[fnName("key")] pattern
  const keyMatch = jsCode.match(/\{\}\s*window\[([^(]+)\s*\(\s*["']([^"']+)["']\s*\)/)
  if (!keyMatch) {
    console.warn('[vidsrc] Could not extract decryption fn+key from JS')
    return null
  }

  const fnName = keyMatch[1].trim()
  const key    = keyMatch[2]

  // Find the encrypted element in html using the decrypted key as ID
  // The key itself is sometimes encoded — try to use it directly first
  const encDataMatch = html.match(new RegExp(`id=["']${key}["'][^>]*>([^<]+)`))
                     || html.match(/encryptedData\s*=\s*["']([^"']+)["']/)
                     || html.match(/data-encrypt=["']([^"']+)["']/)

  if (!encDataMatch) {
    // Try getting from the JS directly
    const dataInJs = jsCode.match(/["']([A-Za-z0-9+/=_-]{20,})["']/)
    if (!dataInJs) {
      console.warn('[vidsrc] Could not find encrypted data')
      return null
    }
    const decrypted = decrypt(fnName, dataInJs[1], key)
    if (decrypted && decrypted.includes('.m3u8')) return decrypted
    return null
  }

  const encData   = encDataMatch[1].trim()
  const decrypted = decrypt(fnName, encData, key)
  console.log(`[vidsrc] Decrypted: ${decrypted?.substring(0, 80)}`)
  return decrypted
}

// Step 4: handle srcrcp (some servers use /srcrcp/ instead of /prorcp/)
async function srcrcpHandler(src) {
  const url  = `${BASEDOM}/srcrcp/${src}`
  const html = await getText(url, {
    Referer: BASEDOM + '/',
    Origin:  BASEDOM,
  })
  // Direct m3u8 in page
  const m = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i)
  return m ? m[1] : null
}

// Full vidsrc.xyz extraction pipeline
async function extractVidsrcXyz(type, tmdbId, season = 1, episode = 1) {
  let embedUrl
  if (type === 'tv') {
    embedUrl = `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`
  } else {
    embedUrl = `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`
  }

  const servers = await serversLoad(embedUrl)
  if (!servers.length) throw new Error('No servers found')

  for (const server of servers) {
    try {
      const rcp = await rcpGrabber(server.dataHash)
      if (!rcp) continue

      let m3u8 = null

      if (rcp.src.startsWith('prorcp/') || rcp.src.includes('/prorcp/')) {
        const id = rcp.src.replace(/.*prorcp\//, '')
        m3u8 = await prorcpHandler(id)
      } else if (rcp.src.startsWith('srcrcp/') || rcp.src.includes('/srcrcp/')) {
        const id = rcp.src.replace(/.*srcrcp\//, '')
        m3u8 = await srcrcpHandler(id)
      } else if (rcp.src.includes('.m3u8')) {
        m3u8 = rcp.src
      } else {
        // Try prorcp as default
        m3u8 = await prorcpHandler(rcp.src)
      }

      if (m3u8 && m3u8.includes('.m3u8')) {
        console.log(`[vidsrc.xyz] ✓ Got m3u8: ${m3u8.substring(0, 80)}`)
        return { m3u8, source: 'VidSrc XYZ', referer: BASEDOM + '/' }
      }
    } catch (e) {
      console.warn(`[vidsrc.xyz] Server ${server.dataHash} failed: ${e.message}`)
    }
  }
  throw new Error('All vidsrc.xyz servers failed')
}

// ─────────────────────────────────────────────────────────────────────────────
// METHOD 2: SoaperTV POST API
// ─────────────────────────────────────────────────────────────────────────────

const SOAPER_BASE = 'https://soaper.cc'

async function getTmdbTitle(type, id) {
  const url  = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}`
  const resp = await (await get(url)).json()
  return {
    title: resp.title || resp.name || '',
    year:  (resp.release_date || resp.first_air_date || '').substring(0, 4),
  }
}

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function soaperSearch(title) {
  const url  = `${SOAPER_BASE}/search.html?keyword=${encodeURIComponent(title)}`
  const html = await getText(url, { Referer: SOAPER_BASE + '/' })
  const results = []
  const re = /href=["'](\/[^"']+)["'][^>]*>[^<]*<[^>]+>\s*([^<]+)/gi
  let m
  while ((m = re.exec(html)) !== null) {
    results.push({ url: SOAPER_BASE + m[1], title: m[2].trim() })
  }
  return results
}

async function soaperGetStream(type, tmdbId, season = 1, episode = 1) {
  const { title, year } = await getTmdbTitle(type === 'tv' ? 'tv' : 'movie', tmdbId)
  if (!title) throw new Error('TMDB title lookup failed')

  const results = await soaperSearch(title)
  const normTitle = normalizeTitle(title)
  const match = results.find(r => normalizeTitle(r.title) === normTitle)
  if (!match) throw new Error(`Soaper: no match for "${title}"`)

  let contentUrl = match.url
  if (type === 'tv') {
    // Get episode page
    const showHtml = await getText(contentUrl, { Referer: SOAPER_BASE + '/' })
    // Find season heading and episode links
    const seasonRe  = new RegExp(`Season\\s+${season}[^]*?(?=Season|$)`, 'i')
    const seasonBlock = showHtml.match(seasonRe)?.[0] || showHtml
    const epRe       = /href=["'](\/episode\/[^"']+)["']/gi
    const eps        = []
    let em
    while ((em = epRe.exec(seasonBlock)) !== null) eps.push(em[1])
    if (!eps[episode - 1]) throw new Error(`Soaper: episode ${episode} not found`)
    contentUrl = SOAPER_BASE + eps[episode - 1]
  }

  const pageHtml = await getText(contentUrl, { Referer: SOAPER_BASE + '/' })
  const passMatch = pageHtml.match(/id=["']hId["'][^>]*value=["']([^"']+)["']/)
                  || pageHtml.match(/pass\s*=\s*["']([^"']+)["']/)
  if (!passMatch) throw new Error('Soaper: no pass/hId found')

  const endpoint = type === 'tv'
    ? `${SOAPER_BASE}/home/index/getEInfoAjax`
    : `${SOAPER_BASE}/home/index/getMInfoAjax`

  const body = new URLSearchParams({ pass: passMatch[1] })
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: contentUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(12000),
  })
  const json = await resp.json()
  if (!json.val) throw new Error('Soaper: no val in response')

  const m3u8 = SOAPER_BASE + json.val
  console.log(`[soaper] ✓ Got stream: ${m3u8.substring(0, 80)}`)
  return { m3u8, source: 'SoaperTV', referer: contentUrl }
}

// ─────────────────────────────────────────────────────────────────────────────
// METHOD 3: Last-resort HTML scan (vidsrc.cc, autoembed)
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_SOURCES = [
  {
    label: 'VidSrc CC',
    movie: id => `https://vidsrc.cc/v2/embed/movie/${id}`,
    tv:    (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    label: 'AutoEmbed',
    movie: id => `https://player.autoembed.cc/embed/movie/${id}`,
    tv:    (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
  },
]

const M3U8_RES = [
  /["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/g,
  /file\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /source\s*:\s*["'`]([^"'`]+\.m3u8[^"'`]*)/g,
  /(https?:\/\/[^\s"'<>{}|\\^[\]`]+\.m3u8[^\s"'<>{}|\\^[\]`]*)/g,
]

function scanM3u8(html) {
  const seen = new Set()
  const hits = []
  for (const re of M3U8_RES) {
    re.lastIndex = 0; let m
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      if (/ads?[._-]|beacon|analytics|doubleclick/i.test(m[1])) continue
      hits.push(m[1])
    }
  }
  hits.sort((a, b) => b.length - a.length)
  return hits[0] || null
}

async function extractFallback(type, id, season, episode) {
  for (const src of FALLBACK_SOURCES) {
    try {
      const url  = type === 'tv' ? src.tv(id, season, episode) : src.movie(id)
      const html = await getText(url, { Referer: 'https://google.com/', Origin: new URL(url).origin })
      let m3u8   = scanM3u8(html)
      if (!m3u8) {
        // Follow iframes one level
        const iframeRe = /<iframe[^>]+src=["']([^"']+)/gi
        let im
        while ((im = iframeRe.exec(html)) !== null) {
          try {
            const iHtml = await getText(im[1], { Referer: url })
            m3u8 = scanM3u8(iHtml)
            if (m3u8) break
          } catch {}
        }
      }
      if (m3u8) {
        console.log(`[fallback:${src.label}] ✓ ${m3u8.substring(0, 80)}`)
        return { m3u8, source: src.label, referer: new URL(url).origin + '/' }
      }
    } catch (e) {
      console.warn(`[fallback:${src.label}] ✗ ${e.message}`)
    }
  }
  throw new Error('All fallback sources failed')
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/stream/:type/:id
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params
  const season  = parseInt(req.query.s || '1', 10)
  const episode = parseInt(req.query.e || '1', 10)
  const cacheKey = `${type}:${id}:${season}:${episode}`

  const cached = getCache(cacheKey)
  if (cached) {
    console.log(`[cache HIT] ${cacheKey}`)
    return res.json(cached)
  }

  const baseHost = `${req.protocol}://${req.get('host')}`

  // Try each method in order
  const methods = [
    () => extractVidsrcXyz(type, id, season, episode),
    () => soaperGetStream(type, id, season, episode),
    () => extractFallback(type, id, season, episode),
  ]

  for (const method of methods) {
    try {
      const result = await method()
      if (!result?.m3u8) continue

      // Wrap m3u8 through our proxy
      const proxied = `${baseHost}/api/proxy?url=${encodeURIComponent(result.m3u8)}&ref=${encodeURIComponent(result.referer || '')}`
      const payload = { ok: true, m3u8: proxied, source: result.source, raw: result.m3u8 }
      setCache(cacheKey, payload)
      return res.json(payload)
    } catch (e) {
      console.warn(`[stream] Method failed: ${e.message}`)
    }
  }

  res.status(404).json({ ok: false, error: 'All extraction methods failed. The title may not be available on any source.' })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/proxy  —  CORS proxy for m3u8 manifests + .ts segments
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url
  if (!raw) return res.status(400).send('missing url param')

  const target  = decodeURIComponent(raw)
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : ''

  let origin
  try { origin = new URL(target).origin } catch { origin = 'https://vidsrc.xyz' }

  const headers = {
    'User-Agent': UA,
    Referer:      referer || origin + '/',
    Origin:       origin,
    Accept:       '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  let upstream
  try {
    upstream = await fetch(target, { headers, signal: AbortSignal.timeout(20000) })
  } catch (e) {
    return res.status(502).send(`proxy fetch error: ${e.message}`)
  }

  if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`)

  const ct      = upstream.headers.get('content-type') || ''
  const isM3u8  = ct.includes('mpegurl') || ct.includes('x-mpegURL') || target.includes('.m3u8')

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (isM3u8) {
    const text    = await upstream.text()
    const base    = target.substring(0, target.lastIndexOf('/') + 1)
    const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?ref=${encodeURIComponent(referer)}&url=`
    const rewritten = rewriteManifest(text, base, proxyBase)
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.send(rewritten)
  }

  // Binary segment — stream through
  const buf = Buffer.from(await upstream.arrayBuffer())
  res.setHeader('Content-Type', ct || 'video/mp2t')
  return res.send(buf)
})

function rewriteManifest(text, base, proxyBase) {
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
  if (url.startsWith('//'))   return 'https:' + url
  if (url.startsWith('/')) {
    try { return new URL(base).origin + url } catch {}
  }
  return base + url
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }))

app.listen(PORT, () => console.log(`apex-stream-api on :${PORT}`))
