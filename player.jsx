// src/pages/Player.jsx
// Calls your Render.com backend → gets a proxied m3u8 → plays via hls.js
// NO npm install needed — hls.js loads from CDN at runtime

import React, {
  useEffect, useRef, useState, useCallback,
} from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, Play, Pause, Volume2, VolumeX,
  Maximize, Minimize, Settings, RefreshCw,
  SkipBack, SkipForward, AlertCircle, Languages,
  Gauge, Loader2,
} from 'lucide-react'

// ─── Backend URL ──────────────────────────────────────────────────────────────
// In development: http://localhost:3001
// In production:  your Render URL (set VITE_STREAM_API in Vercel env vars)
const API = import.meta.env.VITE_STREAM_API || 'http://localhost:3001'

// ─── Load hls.js from CDN (no npm install) ───────────────────────────────────
let _hlsPromise = null
function loadHls() {
  if (_hlsPromise) return _hlsPromise
  _hlsPromise = new Promise(resolve => {
    if (window.Hls) return resolve(window.Hls)
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js'
    s.onload  = () => resolve(window.Hls)
    s.onerror = () => resolve(null)
    document.head.appendChild(s)
  })
  return _hlsPromise
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = s => {
  if (!s || isNaN(s)) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

// ─────────────────────────────────────────────────────────────────────────────
export default function Player() {
  const { type = 'movie', id } = useParams()
  const navigate = useNavigate()

  const videoRef     = useRef(null)
  const hlsRef       = useRef(null)
  const containerRef = useRef(null)
  const seekRef      = useRef(null)
  const hideTimer    = useRef(null)

  // Playback
  const [playing,    setPlaying]    = useState(false)
  const [muted,      setMuted]      = useState(false)
  const [volume,     setVolume]     = useState(1)
  const [current,    setCurrent]    = useState(0)
  const [duration,   setDuration]   = useState(0)
  const [buffered,   setBuffered]   = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [speed,      setSpeed]      = useState(1)

  // HLS tracks
  const [audioTracks,   setAudioTracks]   = useState([])
  const [activeAudio,   setActiveAudio]   = useState(-1)
  const [qualities,     setQualities]     = useState([])
  const [activeQuality, setActiveQuality] = useState(-1)
  const [subTracks,     setSubTracks]     = useState([])
  const [activeSub,     setActiveSub]     = useState(-1)

  // UI
  const [showUI,     setShowUI]     = useState(true)
  const [showPanel,  setShowPanel]  = useState(false)
  const [panelTab,   setPanelTab]   = useState('audio')
  const [loadState,  setLoadState]  = useState('loading') // loading | playing | error
  const [errorMsg,   setErrorMsg]   = useState('')
  const [srcLabel,   setSrcLabel]   = useState('')

  const [season]  = useState(1)
  const [episode] = useState(1)

  // ── Auto-hide controls ──────────────────────────────────────────────────────
  const resetHide = useCallback(() => {
    setShowUI(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setShowUI(false)
      setShowPanel(false)
    }, 3500)
  }, [])

  useEffect(() => { resetHide(); return () => clearTimeout(hideTimer.current) }, [resetHide])

  // ── Boot: ask backend for stream URL, then init hls.js ────────────────────
  const boot = useCallback(async () => {
    setLoadState('loading')
    setSrcLabel('')
    setAudioTracks([])
    setQualities([])
    setSubTracks([])
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }

    // 1. Ask backend
    let m3u8, source
    try {
      const qs   = type === 'tv' ? `?s=${season}&e=${episode}` : ''
      const resp = await fetch(`${API}/api/stream/${type}/${id}${qs}`)
      const json = await resp.json()
      if (!json.ok) throw new Error(json.error || 'backend error')
      m3u8   = json.m3u8
      source = json.source
    } catch (e) {
      setLoadState('error')
      setErrorMsg(`Could not fetch stream: ${e.message}. Make sure your Render backend is running.`)
      return
    }

    // m3u8 from backend is already a proxied URL like:
    // https://your-render-app.onrender.com/api/proxy?url=...
    // Replace the host with the actual API base
    const proxiedM3u8 = m3u8.startsWith('http') ? m3u8 : `${API}${m3u8}`

    setSrcLabel(source)

    // 2. Init hls.js
    const Hls = await loadHls()
    const video = videoRef.current
    if (!video) return

    if (!Hls || !Hls.isSupported()) {
      // Safari native HLS
      video.src = proxiedM3u8
      video.play().catch(() => {})
      setLoadState('playing')
      return
    }

    const hls = new Hls({
      enableWorker: true,
      xhrSetup: xhr => { xhr.withCredentials = false },
    })
    hlsRef.current = hls

    hls.loadSource(proxiedM3u8)
    hls.attachMedia(video)

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      setQualities([
        { id: -1, label: 'Auto' },
        ...data.levels.map((l, i) => ({
          id: i,
          label: l.height ? `${l.height}p` : `Level ${i + 1}`,
        })),
      ])
      setActiveQuality(-1)

      const at = hls.audioTracks || []
      if (at.length > 0) {
        setAudioTracks(at.map((t, i) => ({
          id: i,
          label: t.name || t.lang || `Track ${i + 1}`,
        })))
        setActiveAudio(hls.audioTrack)
      }

      const st = hls.subtitleTracks || []
      setSubTracks([
        { id: -1, label: 'Off' },
        ...st.map((t, i) => ({ id: i, label: t.name || t.lang || `Sub ${i + 1}` })),
      ])

      setLoadState('playing')
      video.play().catch(() => {})
    })

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, d) => {
      setAudioTracks(d.audioTracks.map((t, i) => ({
        id: i, label: t.name || t.lang || `Track ${i + 1}`,
      })))
    })
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, d) => setActiveAudio(d.id))

    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        setLoadState('error')
        setErrorMsg('HLS fatal error. Try refreshing.')
      }
    })
  }, [type, id, season, episode])

  useEffect(() => {
    boot()
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null } }
  }, [boot])

  // ── Video listeners ─────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    const handlers = {
      play:           () => setPlaying(true),
      pause:          () => setPlaying(false),
      timeupdate:     () => {
        setCurrent(v.currentTime)
        if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1))
      },
      loadedmetadata: () => setDuration(v.duration),
      durationchange: () => setDuration(v.duration),
      volumechange:   () => { setVolume(v.volume); setMuted(v.muted) },
    }
    Object.entries(handlers).forEach(([e, fn]) => v.addEventListener(e, fn))
    return () => Object.entries(handlers).forEach(([e, fn]) => v.removeEventListener(e, fn))
  }, [])

  useEffect(() => {
    const fn = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', fn)
    return () => document.removeEventListener('fullscreenchange', fn)
  }, [])

  // ── Keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return
      const v = videoRef.current; if (!v) return
      const actions = {
        ' ': ()  => { e.preventDefault(); v.paused ? v.play() : v.pause() },
        'k': ()  => { v.paused ? v.play() : v.pause() },
        'ArrowRight': () => { e.preventDefault(); v.currentTime = Math.min(duration, v.currentTime + 10) },
        'ArrowLeft':  () => { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10) },
        'ArrowUp':    () => { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1) },
        'ArrowDown':  () => { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1) },
        'm': () => { v.muted = !v.muted },
        'f': () => { document.fullscreenElement ? document.exitFullscreen() : containerRef.current?.requestFullscreen() },
      }
      actions[e.key]?.()
      resetHide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [duration, resetHide])

  // ── Controls ────────────────────────────────────────────────────────────────
  const togglePlay = () => { const v = videoRef.current; if (!v) return; v.paused ? v.play() : v.pause(); resetHide() }
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted }
  const setVol     = val => { const v = videoRef.current; if (!v) return; v.volume = val; v.muted = val === 0 }
  const toggleFs   = () => document.fullscreenElement ? document.exitFullscreen() : containerRef.current?.requestFullscreen()
  const setSpeedFn = r  => { if (videoRef.current) videoRef.current.playbackRate = r; setSpeed(r) }
  const switchAudio = id => { if (hlsRef.current) hlsRef.current.audioTrack = id; setActiveAudio(id) }
  const switchQ    = id => { if (hlsRef.current) hlsRef.current.currentLevel = id; setActiveQuality(id) }
  const switchSub  = id => { if (hlsRef.current) { hlsRef.current.subtitleTrack = id; hlsRef.current.subtitleDisplay = id !== -1 }; setActiveSub(id) }

  const seek = e => {
    const bar = seekRef.current; if (!bar || !duration) return
    const { left, width } = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - left) / width))
    if (videoRef.current) videoRef.current.currentTime = pct * duration
    setCurrent(pct * duration)
  }

  const pctPlayed   = duration ? (current  / duration) * 100 : 0
  const pctBuffered = duration ? (buffered / duration) * 100 : 0

  // ─── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black z-[100] flex flex-col overflow-hidden select-none"
      onMouseMove={resetHide}
      onTouchStart={resetHide}
    >
      {/* Video */}
      <video ref={videoRef} className="w-full h-full object-contain" playsInline crossOrigin="anonymous" onClick={togglePlay} />

      {/* Loading */}
      {loadState === 'loading' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-[#0f171e]">
          <div className="w-16 h-16 rounded-full border-4 border-[#00a8e1]/20 border-t-[#00a8e1] animate-spin" />
          <p className="text-white font-semibold text-sm">Fetching stream…</p>
          {srcLabel && <p className="text-gray-500 text-xs">via {srcLabel}</p>}
        </div>
      )}

      {/* Error */}
      {loadState === 'error' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-black px-6 text-center">
          <AlertCircle className="w-14 h-14 text-red-500" />
          <div>
            <h2 className="text-white text-xl font-bold mb-2">Stream unavailable</h2>
            <p className="text-gray-400 text-sm max-w-sm">{errorMsg}</p>
          </div>
          <div className="flex gap-3 flex-wrap justify-center">
            <button onClick={boot} className="flex items-center gap-2 bg-[#00a8e1] text-white px-5 py-2.5 rounded-lg font-bold hover:bg-sky-400 transition-colors">
              <RefreshCw className="w-4 h-4" /> Retry
            </button>
            <button onClick={() => navigate(-1)} className="bg-white/10 text-white px-5 py-2.5 rounded-lg font-bold hover:bg-white/20 transition-colors">
              Go back
            </button>
          </div>
        </div>
      )}

      {/* ── CONTROLS OVERLAY ── */}
      {loadState !== 'error' && (
        <div
          className={`absolute inset-0 z-30 flex flex-col justify-between pointer-events-none transition-opacity duration-400 ${showUI ? 'opacity-100' : 'opacity-0'}`}
          style={{ pointerEvents: showUI ? 'auto' : 'none' }}
        >
          {/* Top bar */}
          <div className="flex items-center gap-3 px-4 md:px-6 py-4 bg-gradient-to-b from-black/90 via-black/40 to-transparent">
            <button onClick={() => navigate(-1)} className="text-white hover:bg-white/20 p-1.5 rounded-full transition-colors flex-shrink-0">
              <ChevronLeft className="w-7 h-7" />
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-sm md:text-base uppercase tracking-widest leading-none">Now Playing</p>
              {srcLabel && <p className="text-[11px] text-gray-400 mt-0.5">via <span className="text-[#00a8e1] font-semibold">{srcLabel}</span></p>}
            </div>
            <button onClick={boot} title="Refresh stream" className="text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors">
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>

          {/* Centre play */}
          <button onClick={togglePlay}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center hover:bg-black/60 hover:scale-110 transition-all">
            {playing ? <Pause fill="white" className="w-9 h-9 text-white" /> : <Play fill="white" className="w-9 h-9 text-white ml-1" />}
          </button>

          {/* Bottom bar */}
          <div className="px-4 md:px-6 pb-4 pt-2 bg-gradient-to-t from-black/95 via-black/50 to-transparent">
            {/* Seek */}
            <div ref={seekRef} onClick={seek}
              className="relative h-[5px] mb-4 rounded-full bg-white/20 cursor-pointer group">
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/25 pointer-events-none" style={{ width: `${pctBuffered}%` }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-[#00a8e1] pointer-events-none" style={{ width: `${pctPlayed}%` }} />
              <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg pointer-events-none" style={{ left: `calc(${pctPlayed}% - 8px)` }} />
            </div>

            {/* Controls */}
            <div className="flex items-center gap-2 md:gap-3">
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime -= 10 }} className="text-white/80 hover:text-white hidden sm:block transition-colors"><SkipBack className="w-5 h-5" /></button>
              <button onClick={togglePlay} className="text-white hover:text-[#00a8e1] transition-colors">
                {playing ? <Pause fill="white" className="w-6 h-6" /> : <Play fill="white" className="w-6 h-6 ml-0.5" />}
              </button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime += 10 }} className="text-white/80 hover:text-white hidden sm:block transition-colors"><SkipForward className="w-5 h-5" /></button>
              <button onClick={toggleMute} className="text-white hover:text-[#00a8e1] transition-colors">
                {muted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              <input type="range" min="0" max="1" step="0.02" value={muted ? 0 : volume}
                onChange={e => setVol(parseFloat(e.target.value))}
                onClick={e => e.stopPropagation()}
                className="w-20 md:w-28 accent-[#00a8e1] cursor-pointer" />
              <span className="text-white/80 text-xs font-mono tabular-nums ml-1 hidden sm:inline">{fmt(current)} / {fmt(duration)}</span>
              <div className="flex-1" />

              {/* Settings */}
              <div className="relative" onClick={e => e.stopPropagation()}>
                <button onClick={() => { setShowPanel(p => !p); resetHide() }}
                  className={`p-1.5 rounded-lg transition-colors hover:bg-white/10 ${showPanel ? 'text-[#00a8e1]' : 'text-white'}`}>
                  <Settings className="w-5 h-5" />
                </button>

                {showPanel && (
                  <div className="absolute bottom-12 right-0 w-72 rounded-2xl overflow-hidden shadow-2xl bg-[#0d1620]/98 border border-white/10 backdrop-blur-xl z-40">
                    {/* Tabs */}
                    <div className="flex border-b border-white/10">
                      {[
                        { id: 'audio',   icon: <Languages className="w-4 h-4" />, label: 'Audio'   },
                        { id: 'quality', icon: <Gauge      className="w-4 h-4" />, label: 'Quality' },
                        { id: 'speed',   icon: <Gauge      className="w-4 h-4" />, label: 'Speed'   },
                        { id: 'subs',    icon: <Settings   className="w-3 h-3" />, label: 'Subs'    },
                      ].map(tab => (
                        <button key={tab.id} onClick={() => setPanelTab(tab.id)}
                          className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors ${panelTab === tab.id ? 'text-[#00a8e1] border-b-2 border-[#00a8e1]' : 'text-gray-500 hover:text-gray-300'}`}>
                          {tab.icon}{tab.label}
                        </button>
                      ))}
                    </div>

                    {/* Audio */}
                    {panelTab === 'audio' && (
                      <div className="max-h-56 overflow-y-auto py-1">
                        {audioTracks.length === 0
                          ? <p className="text-gray-600 text-xs text-center py-8 px-4">No alternate audio tracks.<br/>Multi-audio depends on the stream source.</p>
                          : audioTracks.map(t => (
                            <button key={t.id} onClick={() => switchAudio(t.id)}
                              className={`w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors hover:bg-white/10 ${t.id === activeAudio ? 'text-[#00a8e1] bg-[#00a8e1]/8' : 'text-gray-300'}`}>
                              <span>{t.label}</span>
                              {t.id === activeAudio && <span className="w-2 h-2 rounded-full bg-[#00a8e1]" />}
                            </button>
                          ))
                        }
                      </div>
                    )}

                    {/* Quality */}
                    {panelTab === 'quality' && (
                      <div className="max-h-56 overflow-y-auto py-1">
                        {qualities.length === 0
                          ? <p className="text-gray-600 text-xs text-center py-8">Loading…</p>
                          : qualities.map(q => (
                            <button key={q.id} onClick={() => switchQ(q.id)}
                              className={`w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors hover:bg-white/10 ${q.id === activeQuality ? 'text-[#00a8e1] bg-[#00a8e1]/8' : 'text-gray-300'}`}>
                              <span>{q.label}</span>
                              {q.id === activeQuality && <span className="w-2 h-2 rounded-full bg-[#00a8e1]" />}
                            </button>
                          ))
                        }
                      </div>
                    )}

                    {/* Speed */}
                    {panelTab === 'speed' && (
                      <div className="py-1">
                        {SPEEDS.map(r => (
                          <button key={r} onClick={() => setSpeedFn(r)}
                            className={`w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors hover:bg-white/10 ${r === speed ? 'text-[#00a8e1] bg-[#00a8e1]/8' : 'text-gray-300'}`}>
                            <span>{r === 1 ? 'Normal' : `${r}×`}</span>
                            {r === speed && <span className="w-2 h-2 rounded-full bg-[#00a8e1]" />}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Subs */}
                    {panelTab === 'subs' && (
                      <div className="max-h-56 overflow-y-auto py-1">
                        {subTracks.length <= 1
                          ? <p className="text-gray-600 text-xs text-center py-8">No subtitles in this stream.</p>
                          : subTracks.map(t => (
                            <button key={t.id} onClick={() => switchSub(t.id)}
                              className={`w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors hover:bg-white/10 ${t.id === activeSub ? 'text-[#00a8e1] bg-[#00a8e1]/8' : 'text-gray-300'}`}>
                              <span>{t.label}</span>
                              {t.id === activeSub && <span className="w-2 h-2 rounded-full bg-[#00a8e1]" />}
                            </button>
                          ))
                        }
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button onClick={toggleFs} className="text-white hover:text-[#00a8e1] transition-colors ml-1">
                {fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}