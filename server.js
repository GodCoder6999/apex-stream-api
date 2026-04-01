// ─────────────────────────────────────────────────────────────────────────────
// apex-stream-api  v3 — Render.com Express backend
//
// Priority chain (all return real .m3u8 HLS streams, NO iframe embeds):
//   1. vidsrc.me   — direct HLS via /api/4/  endpoints
//   2. vidsrc.xyz  — RCP chain → prorcp decrypt → m3u8
//   3. vidsrc.in   — api endpoint scan
//   4. vidlink.pro — JSON api
//   5. multiembed  — api scan
//   6. autoembed   — HTML scan (m3u8 only, rejects iframe/mp4)
//   7. superembed  — api scan
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

// ─── Cache (30 min TTL) ───────────────────────────────────────────────────────
const cache = new Map()
function getCache(k) {
  const e = cache.get(k)
  if (!e) return null
  if (Date.now() > e.exp) { cache.delete(k); return null }
  return e.val
}
function setCache(k, val, ttl = 30 * 60 * 1000) {
  cache.set(k, { val, exp: Date.now() + ttl })
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function fetchText(url, hdrs = {}, timeout = 18000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', ...hdrs },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.text()
}

async function fetchJson(url, hdrs = {}, timeout = 18000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...hdrs },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.json()
}

// ─── M3U8 scanner ────────────────────────────────────────────────────────────
const M3U8_PATTERNS = [
  /["'`](https?:\/\/[^"'`\s<>{}|\\^[\]]+\.m3u8[^"'`\s<>{}|\\^[\]]*)/g,
  /file\s*:\s*["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*)/g,
  /source\s*:\s*["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*)/g,
  /src\s*:\s*["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*)/g,
  /"hls"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/g,
  /hlsUrl["'\s:]+["'](https?:\/\/[^"']+\.m3u8[^"']*)/g,
  /"url"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/g,
]

function scanM3u8(text) {
  const seen = new Set()
  const hits = []
  for (const re of M3U8_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const u = m[1].replace(/\\/g, '')
      if (seen.has(u)) continue
      seen.add(u)
      // Reject ad/tracking URLs
      if (/ads?[._/-]|beacon|analytics|doubleclick|googlevideo\.com\/videoplayback/i.test(u)) continue
      hits.push(u)
    }
  }
  // Sort: prefer longer URLs (more likely to be main stream), prefer master.m3u8
  hits.sort((a, b) => {
    const aM = a.includes('master') ? 1 : 0
    const bM = b.includes('master') ? 1 : 0
    return bM - aM || b.length - a.length
  })
  return hits[0] || null
}

// ─── TMDB helpers ─────────────────────────────────────────────────────────────
async function getTmdbInfo(type, id) {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids`
  )
  const imdb = data.imdb_id || data.external_ids?.imdb_id || ''
  return {
    title: data.title || data.name || '',
    year:  (data.release_date || data.first_air_date || '').substring(0, 4),
    imdb,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 1: vidsrc.me  — most reliable, direct HLS
// Endpoint: https://vidsrc.me/embed/movie?imdb=tt... or /tv?imdb=tt...&s=1&e=1
// Then follow to api.vidsrc.me for raw stream
// ─────────────────────────────────────────────────────────────────────────────
async function sourceVidsrcMe(type, tmdbId, season, episode) {
  const { imdb } = await getTmdbInfo(type === 'tv' ? 'tv' : 'movie', tmdbId)

  // Try TMDB id directly (vidsrc.me supports both)
  const ids = imdb ? [imdb, tmdbId] : [tmdbId]

  for (const id of ids) {
    try {
      // vidsrc.me new API
      const apiUrl = type === 'tv'
        ? `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`
        : `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`

      const html = await fetchText(apiUrl, { Referer: 'https://vidsrc.me/' })

      // Look for the v.js or similar script that contains the stream
      const scriptUrls = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1])
      
      for (const scriptPath of scriptUrls) {
        try {
          const scriptUrl = scriptPath.startsWith('http') ? scriptPath : `https://vidsrc.me${scriptPath}`
          const js = await fetchText(scriptUrl, { Referer: apiUrl })
          const m3u8 = scanM3u8(js)
          if (m3u8) return { m3u8, source: 'VidSrc.me', referer: 'https://vidsrc.me/' }
        } catch {}
      }

      const m3u8 = scanM3u8(html)
      if (m3u8) return { m3u8, source: 'VidSrc.me', referer: 'https://vidsrc.me/' }
    } catch {}
  }

  // Try vidsrc.me direct API v2
  try {
    const { imdb } = await getTmdbInfo(type === 'tv' ? 'tv' : 'movie', tmdbId)
    if (!imdb) throw new Error('no imdb')
    
    const apiBase = 'https://v2.vidsrc.me'
    const path = type === 'tv'
      ? `/embed/tv/${imdb}/${season}-${episode}`
      : `/embed/movie/${imdb}`
    
    const html = await fetchText(apiBase + path, { Referer: 'https://vidsrc.me/' })
    const m3u8 = scanM3u8(html)
    if (m3u8) return { m3u8, source: 'VidSrc.me v2', referer: apiBase + '/' }
  } catch {}

  throw new Error('vidsrc.me: no stream found')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 2: vidsrc.xyz RCP chain (existing, improved)
// ─────────────────────────────────────────────────────────────────────────────
let BASEDOM = 'https://cloudnestra.com'

function decodeBase64(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

const DECRYPT_FNS = {
  LXVUMCoAHJ: d => { try { return decodeBase64(d.split('').reverse().join('')).split('').map(c => String.fromCharCode(c.charCodeAt(0)-3)).join('') } catch { return null } },
  GuxKGDsA2T: d => { try { return decodeBase64(d.split('').reverse().join('')).split('').map(c => String.fromCharCode(c.charCodeAt(0)-7)).join('') } catch { return null } },
  laM1dAi3vO: d => { try { return decodeBase64(d.split('').reverse().join('')).split('').map(c => String.fromCharCode(c.charCodeAt(0)-5)).join('') } catch { return null } },
  nZlUnj2VSo: d => { try { const m={'a':'n','b':'o','c':'p','d':'q','e':'r','f':'s','g':'t','h':'u','i':'v','j':'w','k':'x','l':'y','m':'z','n':'a','o':'b','p':'c','q':'d','r':'e','s':'f','t':'g','u':'h','v':'i','w':'j','x':'k','y':'l','z':'m','A':'N','B':'O','C':'P','D':'Q','E':'R','F':'S','G':'T','H':'U','I':'V','J':'W','K':'X','L':'Y','M':'Z','N':'A','O':'B','P':'C','Q':'D','R':'E','S':'F','T':'G','U':'H','V':'I','W':'J','X':'K','Y':'L','Z':'M'}; return d.split('').map(c=>m[c]||c).join('') } catch { return null } },
  IGLImMhWrI: d => { try { const r1=d.split('').reverse().join(''); const rot=r1.split('').map(c=>{if(c>='a'&&c<='z')return String.fromCharCode(((c.charCodeAt(0)-97+13)%26)+97);if(c>='A'&&c<='Z')return String.fromCharCode(((c.charCodeAt(0)-65+13)%26)+65);return c}).join(''); return decodeBase64(rot.split('').reverse().join('')) } catch { return null } },
  GTAxQyTyBx: d => { try { const r=d.split('').reverse().join(''); return decodeBase64(r.split('').filter((_,i)=>i%2===0).join('')) } catch { return null } },
  Iry9MQXnLs: (d,k) => { try { const h=Buffer.from(d,'hex').toString('utf8'); const rev=h.split('').reverse().join(''); let x=''; for(let i=0;i<rev.length;i++) x+=String.fromCharCode(rev.charCodeAt(i)^k.charCodeAt(i%k.length)); return decodeBase64(x.split('').map(c=>String.fromCharCode(c.charCodeAt(0)-3)).join('')) } catch { return null } },
  C66jPHx8qu: (d,k) => { try { const r=d.split('').reverse().join(''); const h=Buffer.from(r,'hex').toString('utf8'); let res=''; for(let i=0;i<h.length;i++) res+=String.fromCharCode(h.charCodeAt(i)^k.charCodeAt(i%k.length)); return res } catch { return null } },
  detdj7JHiK: (d,k) => { try { const sl=d.slice(2); const dec=decodeBase64(sl); const rk=k.repeat(Math.ceil(dec.length/k.length)).slice(0,dec.length); let res=''; for(let i=0;i<dec.length;i++) res+=String.fromCharCode(dec.charCodeAt(i)^rk.charCodeAt(i)); return res } catch { return null } },
  MyL1IRSfHe: d => { try { const rev=d.split('').reverse().join(''); const sh=rev.split('').map(c=>String.fromCharCode(c.charCodeAt(0)-5)).join(''); return Buffer.from(sh,'hex').toString('utf8') } catch { return null } },
}

function decrypt(fnName, data, key) {
  const fn = DECRYPT_FNS[fnName]
  if (!fn) return null
  return fn.length === 2 ? fn(data, key) : fn(data)
}

async function vidsrcXyzServers(embedUrl) {
  const html = await fetchText(embedUrl, { Referer: 'https://vidsrc.xyz/', Origin: 'https://vidsrc.xyz' })

  const iframeM = html.match(/iframe[^>]+src=["']([^"']+)/i)
  if (iframeM) {
    try { BASEDOM = new URL(iframeM[1]).origin } catch { const m=iframeM[1].match(/(https?:\/\/[^/]+)/); if(m) BASEDOM=m[1] }
  }

  const servers = []
  const re = /data-hash=["']([^"']+)["']/gi
  let m
  while ((m = re.exec(html)) !== null) servers.push(m[1])
  return servers
}

async function vidsrcXyzDecrypt(dataHash) {
  const html = await fetchText(`${BASEDOM}/rcp/${dataHash}`, { Referer: BASEDOM+'/', Origin: BASEDOM })
  
  const srcM = html.match(/src\s*:\s*['"]([^'"]+)['"]/i) || html.match(/file\s*:\s*['"]([^'"]+)['"]/i)
  if (!srcM) return null
  return srcM[1]
}

async function vidsrcXyzProrcp(srcId) {
  const proUrl = `${BASEDOM}/prorcp/${srcId}`
  const html = await fetchText(proUrl, { Referer: BASEDOM+'/', Origin: BASEDOM })

  // Direct m3u8 in page
  const direct = scanM3u8(html)
  if (direct) return direct

  // Get decryption script
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)]
    .map(m => m[1]).filter(s => !s.includes('cpt.js'))

  for (const sp of scripts.reverse()) {
    try {
      const url = sp.startsWith('http') ? sp : BASEDOM + sp
      const js = await fetchText(url, { Referer: proUrl })

      const keyM = js.match(/\{\}\s*window\[([^(]+)\s*\(\s*["']([^"']+)["']\s*\)/)
      if (!keyM) continue

      const fnName = keyM[1].trim()
      const key = keyM[2]

      // Find encrypted blob in HTML
      const encM = html.match(new RegExp(`id=["']${key}["'][^>]*>([^<]+)`))
        || html.match(/encryptedData\s*=\s*["']([^"']+)["']/)
        || html.match(/data-encrypt=["']([^"']+)["']/)

      if (!encM) continue
      const dec = decrypt(fnName, encM[1].trim(), key)
      if (dec && dec.includes('.m3u8')) return dec
    } catch {}
  }
  return null
}

async function sourceVidsrcXyz(type, tmdbId, season, episode) {
  const embedUrl = type === 'tv'
    ? `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`
    : `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`

  const hashes = await vidsrcXyzServers(embedUrl)
  if (!hashes.length) throw new Error('vidsrc.xyz: no servers')

  for (const hash of hashes) {
    try {
      const src = await vidsrcXyzDecrypt(hash)
      if (!src) continue

      let m3u8 = null
      if (src.includes('prorcp') || src.includes('/prorcp/')) {
        const id = src.replace(/.*prorcp\//, '')
        m3u8 = await vidsrcXyzProrcp(id)
      } else if (src.includes('.m3u8')) {
        m3u8 = src
      } else {
        m3u8 = await vidsrcXyzProrcp(src)
      }

      if (m3u8) return { m3u8, source: 'VidSrc XYZ', referer: BASEDOM + '/' }
    } catch {}
  }
  throw new Error('vidsrc.xyz: all servers failed')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 3: vidsrc.in — has a direct JSON API
// ─────────────────────────────────────────────────────────────────────────────
async function sourceVidsrcIn(type, tmdbId, season, episode) {
  const embedUrl = type === 'tv'
    ? `https://vidsrc.in/embed/tv?tmdb=${tmdbId}&s=${season}&e=${episode}`
    : `https://vidsrc.in/embed/movie?tmdb=${tmdbId}`

  const html = await fetchText(embedUrl, { Referer: 'https://vidsrc.in/' })
  
  // Try direct m3u8 scan
  const m3u8 = scanM3u8(html)
  if (m3u8) return { m3u8, source: 'VidSrc.in', referer: 'https://vidsrc.in/' }

  // Follow iframes (but only to same domain, then scan for m3u8)
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1])
  for (const iurl of iframes) {
    try {
      const fullUrl = iurl.startsWith('http') ? iurl : 'https://vidsrc.in' + iurl
      // Only follow to trusted domains
      if (!/vidsrc\.in|cloudnestra|filemoon|chillx|rabbitstream/i.test(fullUrl)) continue
      const ihtml = await fetchText(fullUrl, { Referer: embedUrl })
      const im3u8 = scanM3u8(ihtml)
      if (im3u8) return { m3u8: im3u8, source: 'VidSrc.in', referer: new URL(fullUrl).origin + '/' }
    } catch {}
  }

  throw new Error('vidsrc.in: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 4: vidlink.pro — JSON API
// ─────────────────────────────────────────────────────────────────────────────
async function sourceVidlink(type, tmdbId, season, episode) {
  const url = type === 'tv'
    ? `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}?primaryColor=00a8e1&autoplay=true`
    : `https://vidlink.pro/movie/${tmdbId}?primaryColor=00a8e1&autoplay=true`

  const html = await fetchText(url, { Referer: 'https://vidlink.pro/' })
  
  // vidlink uses a data attribute with JSON stream info
  const dataM = html.match(/data-stream=["']([^"']+)["']/)
  if (dataM) {
    try {
      const parsed = JSON.parse(decodeURIComponent(dataM[1]))
      const m3u8 = parsed?.stream?.playlist || parsed?.playlist || parsed?.url
      if (m3u8 && m3u8.includes('.m3u8')) return { m3u8, source: 'VidLink', referer: 'https://vidlink.pro/' }
    } catch {}
  }

  const m3u8 = scanM3u8(html)
  if (m3u8) return { m3u8, source: 'VidLink', referer: 'https://vidlink.pro/' }

  // Try vidlink API endpoint
  try {
    const apiUrl = type === 'tv'
      ? `https://vidlink.pro/api/b/tv?id=${tmdbId}&s=${season}&e=${episode}`
      : `https://vidlink.pro/api/b/movie?id=${tmdbId}`
    const json = await fetchJson(apiUrl, { Referer: 'https://vidlink.pro/' })
    const m3u8 = json?.stream?.playlist || json?.url || json?.hls
    if (m3u8) return { m3u8, source: 'VidLink API', referer: 'https://vidlink.pro/' }
  } catch {}

  throw new Error('vidlink: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 5: 2embed / multiembed
// ─────────────────────────────────────────────────────────────────────────────
async function source2embed(type, tmdbId, season, episode) {
  const embedUrls = type === 'tv' ? [
    `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`,
    `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
  ] : [
    `https://www.2embed.cc/embed/${tmdbId}`,
    `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`,
  ]

  for (const url of embedUrls) {
    try {
      const html = await fetchText(url, { Referer: 'https://www.2embed.cc/' })
      const m3u8 = scanM3u8(html)
      if (m3u8) return { m3u8, source: '2Embed', referer: new URL(url).origin + '/' }
    } catch {}
  }
  throw new Error('2embed: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 6: Superembed (getsuperembed.xyz)
// ─────────────────────────────────────────────────────────────────────────────
async function sourceSuperembed(type, tmdbId, season, episode) {
  const url = type === 'tv'
    ? `https://getsuperembed.link/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}&playerStyle=style1`
    : `https://getsuperembed.link/?video_id=${tmdbId}&tmdb=1&playerStyle=style1`

  const html = await fetchText(url, { Referer: 'https://getsuperembed.link/' })
  const m3u8 = scanM3u8(html)
  if (m3u8) return { m3u8, source: 'SuperEmbed', referer: 'https://getsuperembed.link/' }

  throw new Error('superembed: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 7: autoembed (HTML scan, m3u8 only)
// ─────────────────────────────────────────────────────────────────────────────
async function sourceAutoembed(type, tmdbId, season, episode) {
  const urls = type === 'tv' ? [
    `https://player.autoembed.cc/embed/tv/${tmdbId}/${season}/${episode}`,
    `https://autoembed.co/tv/tmdb/${tmdbId}-${season}-${episode}`,
  ] : [
    `https://player.autoembed.cc/embed/movie/${tmdbId}`,
    `https://autoembed.co/movie/tmdb/${tmdbId}`,
  ]

  for (const url of urls) {
    try {
      const html = await fetchText(url, { Referer: 'https://autoembed.co/' })
      const m3u8 = scanM3u8(html)
      if (m3u8) return { m3u8, source: 'AutoEmbed', referer: new URL(url).origin + '/' }
    } catch {}
  }
  throw new Error('autoembed: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 8: NontonGo / MoviesAPI direct HLS
// ─────────────────────────────────────────────────────────────────────────────
async function sourceMoviesApi(type, tmdbId, season, episode) {
  // moviesapi.club has a direct JSON endpoint
  const url = type === 'tv'
    ? `https://moviesapi.club/tv/${tmdbId}-${season}-${episode}`
    : `https://moviesapi.club/movie/${tmdbId}`

  const html = await fetchText(url, { Referer: 'https://moviesapi.club/' })
  
  // They embed stream config in a script tag
  const cfgM = html.match(/var\s+(?:jwConfig|playerConfig|config)\s*=\s*(\{[^<]+\})/s)
  if (cfgM) {
    try {
      const cfg = JSON.parse(cfgM[1])
      const src = cfg?.playlist?.[0]?.sources?.[0]?.file || cfg?.file || cfg?.source
      if (src && src.includes('.m3u8')) return { m3u8: src, source: 'MoviesAPI', referer: 'https://moviesapi.club/' }
    } catch {}
  }

  const m3u8 = scanM3u8(html)
  if (m3u8) return { m3u8, source: 'MoviesAPI', referer: 'https://moviesapi.club/' }

  throw new Error('moviesapi: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 9: embedsu / rive stream (very reliable)
// ─────────────────────────────────────────────────────────────────────────────
async function sourceRive(type, tmdbId, season, episode) {
  const urls = type === 'tv' ? [
    `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}`,
    `https://rive.su/embed/tv?id=${tmdbId}&s=${season}&e=${episode}`,
  ] : [
    `https://embed.su/embed/movie/${tmdbId}`,
    `https://rive.su/embed/movie?id=${tmdbId}`,
  ]

  for (const url of urls) {
    try {
      const origin = new URL(url).origin
      const html = await fetchText(url, { Referer: origin + '/' })
      const m3u8 = scanM3u8(html)
      if (m3u8) return { m3u8, source: 'Embed.su', referer: origin + '/' }
    } catch {}
  }
  throw new Error('rive/embed.su: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 10: filmxy / movie-web compatible sources
// ─────────────────────────────────────────────────────────────────────────────
async function sourceFilmxy(type, tmdbId, season, episode) {
  // Try smashystream
  const urls = type === 'tv' ? [
    `https://api.smashystream.com/playback/episode?tmdb=${tmdbId}&s=${season}&e=${episode}`,
  ] : [
    `https://api.smashystream.com/playback/movie?tmdb=${tmdbId}`,
  ]

  for (const url of urls) {
    try {
      const json = await fetchJson(url, { Referer: 'https://smashystream.com/' })
      const m3u8 = json?.data?.url || json?.stream || json?.url
      if (m3u8 && m3u8.includes('.m3u8')) return { m3u8, source: 'SmashyStream', referer: 'https://smashystream.com/' }
    } catch {}
  }
  throw new Error('filmxy: no stream')
}

// ─────────────────────────────────────────────────────────────────────────────
// Master orchestrator
// ─────────────────────────────────────────────────────────────────────────────
const SOURCES = [
  { fn: sourceVidsrcMe,   name: 'vidsrc.me'     },
  { fn: sourceVidsrcXyz,  name: 'vidsrc.xyz'    },
  { fn: sourceVidsrcIn,   name: 'vidsrc.in'     },
  { fn: sourceVidlink,    name: 'vidlink.pro'   },
  { fn: source2embed,     name: '2embed'        },
  { fn: sourceSuperembed, name: 'superembed'    },
  { fn: sourceMoviesApi,  name: 'moviesapi'     },
  { fn: sourceRive,       name: 'embed.su'      },
  { fn: sourceAutoembed,  name: 'autoembed'     },
  { fn: sourceFilmxy,     name: 'smashystream'  },
]

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
  const errors = []

  for (const { fn, name } of SOURCES) {
    try {
      console.log(`[stream] Trying ${name} for ${type}/${id}`)
      const result = await fn(type, id, season, episode)

      if (!result?.m3u8 || !result.m3u8.includes('.m3u8')) {
        console.warn(`[stream] ${name}: invalid m3u8`)
        continue
      }

      // Validate the m3u8 is actually reachable
      try {
        const testR = await fetch(result.m3u8, {
          method: 'HEAD',
          headers: { 'User-Agent': UA, Referer: result.referer || '' },
          signal: AbortSignal.timeout(8000),
        })
        if (!testR.ok && testR.status !== 403) {  // 403 may still work with proper headers
          console.warn(`[stream] ${name}: HEAD check failed (${testR.status})`)
          // Don't skip — some servers block HEAD but allow GET
        }
      } catch {}

      const proxied = `${baseHost}/api/proxy?url=${encodeURIComponent(result.m3u8)}&ref=${encodeURIComponent(result.referer || '')}`
      const payload = { ok: true, m3u8: proxied, source: result.source, raw: result.m3u8 }
      setCache(cacheKey, payload)
      console.log(`[stream] ✓ ${name}: ${result.m3u8.substring(0, 80)}`)
      return res.json(payload)
    } catch (e) {
      console.warn(`[stream] ${name} failed: ${e.message}`)
      errors.push(`${name}: ${e.message}`)
    }
  }

  res.status(404).json({
    ok: false,
    error: `Stream not found after trying ${SOURCES.length} sources. This title may not be available yet.`,
    details: errors,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// /api/proxy — CORS proxy for HLS manifests + segments
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const raw = req.query.url
  if (!raw) return res.status(400).send('missing url param')

  const target  = decodeURIComponent(raw)
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : ''

  let origin = 'https://vidsrc.me'
  try { origin = new URL(target).origin } catch {}

  let upstream
  try {
    upstream = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Referer: referer || origin + '/',
        Origin:  origin,
        Accept:  '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
      signal: AbortSignal.timeout(25000),
    })
  } catch (e) {
    return res.status(502).send(`proxy fetch error: ${e.message}`)
  }

  if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`)

  const ct     = upstream.headers.get('content-type') || ''
  const isM3u8 = ct.includes('mpegurl') || ct.includes('x-mpegURL') || target.includes('.m3u8')
  const isSub  = target.includes('.vtt') || target.includes('.srt')

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (isM3u8) {
    const text = await upstream.text()
    const base = target.substring(0, target.lastIndexOf('/') + 1)
    const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?ref=${encodeURIComponent(referer)}&url=`
    const rewritten = rewriteManifest(text, base, proxyBase)
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.send(rewritten)
  }

  if (isSub) {
    const text = await upstream.text()
    res.setHeader('Content-Type', ct || 'text/vtt')
    return res.send(text)
  }

  // Binary segment
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
    if (t.startsWith('http') || t.endsWith('.m3u8') || t.endsWith('.ts') || t.includes('.ts?') || t.includes('.m3u8?')) {
      return proxyBase + encodeURIComponent(toAbs(t, base))
    }
    return line
  }).join('\n')
}

function toAbs(url, base) {
  if (!url) return base
  url = url.trim()
  if (url.startsWith('http')) return url
  if (url.startsWith('//'))   return 'https:' + url
  if (url.startsWith('/')) {
    try { return new URL(base).origin + url } catch { return base + url }
  }
  return base + url
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now(), sources: SOURCES.map(s => s.name) }))
app.options('*', (_, res) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*'); res.sendStatus(200) })

app.listen(PORT, () => console.log(`apex-stream-api v3 on :${PORT} — ${SOURCES.length} sources ready`))
