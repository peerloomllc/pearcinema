// The PearCinema shell: boots the Bare worklet, bridges it to the WebView UI, and
// otherwise stays out of the way.
//
// PearTune's shape (its shell is the donor and carries the scars): the worklet is
// the P2P backend, the WebView is the whole interface, and this file is the only
// place the two meet. Requests ride { id, method, args } both hops - WebView to
// shell over postMessage, shell to worklet over BareKit IPC - and replies come
// back on the same ids. Events push the other way as { event, data }.

import { useEffect, useRef, useState } from 'react'
import { Animated, BackHandler, Easing, Image, PermissionsAndroid, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View, useColorScheme } from 'react-native'
import { MaterialIcons } from '@expo/vector-icons'
// expo-linking, NOT react-native's Linking: on the new architecture the RN
// module's warm 'url' event never fires, so a pairing link tapped while the
// app was running arrived nowhere (measured on the TCL, 2026-08-14 - the
// second half of the pairing-link gap; the donor shell uses expo-linking too).
import * as Linking from 'expo-linking'
import { WebView } from 'react-native-webview'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { VideoView, useVideoPlayer } from 'expo-video'
import { Worklet } from 'react-native-bare-kit'
import * as FileSystem from 'expo-file-system/legacy'
import { Asset } from 'expo-asset'
import * as SplashScreen from 'expo-splash-screen'
import * as ScreenOrientation from 'expo-screen-orientation'
import * as Clipboard from 'expo-clipboard'
import * as SystemUI from 'expo-system-ui'
import * as Haptics from 'expo-haptics'
import b4a from 'b4a'
import { probe as probeDecoders } from '../modules/decoder-probe'
import * as CastRemote from '../modules/cast-remote'

const bundle = require('../assets/bare-universal.bundle')

// HOW LONG THE PLAYING-NEXT CARD WAITS before the next episode starts itself.
// Ten seconds is what a television does, and it is the number to copy rather
// than improve on: long enough to read the title and reach the screen, short
// enough that nobody sits through it.
const NEXT_SECONDS = 10

// The parked pairing link, MODULE scope on purpose. A warm pear:// link makes
// expo-router navigate (there is no /pair route, so +not-found redirects home)
// and that navigation REMOUNTS this component - worklet, WebView, refs and all.
// Anything stashed in a ref dies with the remount and the link vanishes, which
// was the measured half of the pairing-link gap the trace pinned on 2026-08-14.
// A module variable survives; the freshly mounted UI collects it via
// shell.pendingLink. The donor shell carries the same scar in the same shape.
let pendingPairLink: string | null = null

SplashScreen.preventAutoHideAsync().catch(() => {})

// A WebVTT text into cues. Minimal on purpose: timestamps and text are the
// whole contract (the host converts SRT to VTT before it ever gets here), and
// styling tags are stripped rather than rendered. Hour field optional, comma
// tolerated - the host's converter writes dots, but a subtitle that survived
// three tools deserves the benefit of the doubt.
type Cue = { start: number, end: number, text: string }
function parseVtt (raw: string): Cue[] {
  const ts = (s: string) => {
    const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s.trim())
    if (!m) return null
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) +
      Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000
  }
  const cues: Cue[] = []
  for (const block of String(raw).replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter((l) => l.trim())
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti === -1) continue
    const [a, b] = lines[ti].split('-->')
    const start = ts(a)
    const end = ts(b)
    if (start == null || end == null) continue
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim()
    if (text) cues.push({ start, end, text })
  }
  return cues
}

// The strip behind the page, in both themes. These are styles.css's own
// --color-surface-base values: the shell's background has to BE the page's background,
// or the seam shows as a band under the status bar. The dark one was #0f0d0a, a shade
// off the page's #17140f, which reads as a faint darker stripe on a dark phone - the
// same seam as the light-mode band, just quieter.
const DARK_BG = '#17140f'
const LIGHT_BG = '#faf6ee'

export default function App () {
  const webref = useRef<WebView>(null)
  const ipcRef = useRef<any>(null)
  const workletRef = useRef<Worklet | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  // The shell's own calls into the worklet ride NEGATIVE ids, so they can never
  // collide with the UI's positive ones on the same pipe.
  const shellPending = useRef(new Map<number, (v: any) => void>())
  const shellId = useRef(-1)

  // THE PLAYER IS NATIVE - ExoPlayer via expo-video - because the WebView's media
  // stack refuses Matroska, which is 83% of a real library, while ExoPlayer eats
  // it. The WebView stays the whole interface; this overlay exists only while a
  // film runs, pointed at the same loopback shim URL, and the UI keeps OWNING the
  // watch-state writes - the shell only reports positions, so there is exactly one
  // copy of the resume rules.
  const [playing, setPlaying] = useState<{ itemId: string, url: string, title: string, startMs?: number, skin?: string, canCast?: boolean } | null>(null)
  // Previous/Next episode availability, set by the UI (shell.navSet) once it
  // has asked the host what sits on either side. The buttons only hand an
  // intent back to the UI - which episode that intent lands on is its call.
  const [nav, setNav] = useState<{
    hasPrev: boolean,
    hasNext: boolean,
    autoplay: boolean,
    next: { title: string, seriesTitle: string, label: string, runtime: number | null, overview: string, artUrl: string | null } | null
  } | null>(null)

  // PLAYING NEXT. The film is over and the card asks whether to carry on. It is
  // drawn HERE rather than in the web UI for the same reason the lock-screen
  // remote is: the video is a native view covering the whole page, so a card in
  // the WebView would be behind it.
  //
  // `left` is the countdown and null means nothing is going to happen on its
  // own - which is both what the autoplay switch off looks like and what
  // cancelling leaves. Cancel dismisses the card and leaves the finished
  // episode on its last frame with the controls, so nothing closes by itself.
  const [upNext, setUpNext] = useState(false)
  const [left, setLeft] = useState<number | null>(null)
  // The bar under the buttons empties SMOOTHLY (Tim, 2026-08-20), which the
  // per-second number cannot do - it would step ten times and read as a stutter.
  // One ten-second linear animation on the UI thread instead, so it keeps
  // running evenly whatever JS is doing, and it is scaleX rather than width
  // because only a transform can be handed to the native driver.
  const bar = useRef(new Animated.Value(1)).current

  // THE CONTROLS ARE ALL OURS (Tim, 2026-08-15: no mixture of native player
  // buttons and our own). expo-video's native row cannot take custom buttons,
  // its own previous/next only act on a playlist no JS API can supply, and its
  // CC button appears on its own schedule and cannot see the external subtitle
  // files the host serves. So nativeControls is OFF and one consistent set of
  // icon controls is drawn here: back, title and subtitles on top; previous,
  // jump back, play/pause, jump forward and next in the middle; a scrubbable
  // time bar along the bottom. Keep-awake is unaffected - it rides the player
  // (keepScreenOnWhilePlaying), not the native view.
  const [controlsOn, setControlsOn] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [clock, setClock] = useState({ pos: 0, dur: 0 })
  // The scrub-in-progress position, 0..1. Displayed live while a finger is on
  // the bar; the SEEK happens once on release - over a P2P link every seek is
  // a round of range requests, and seeking on every move would flood it.
  const [scrub, setScrub] = useState<number | null>(null)
  const hideTimer = useRef<any>(null)
  const seekBarWidth = useRef(1)

  // WHERE THE PICTURE IS, in wrap coordinates - the skins dress the film, not
  // the letterbox. Same contain-fit arithmetic the subtitle overlay uses,
  // polled gently only while a skin is on.
  const [pict, setPict] = useState<{ left: number, top: number, w: number, h: number } | null>(null)
  useEffect(() => {
    if (!playing || !playing.skin || playing.skin === 'off') { setPict(null); return }
    const read = () => {
      try {
        const { w, h } = wrapSizeRef.current
        const vs: any = player.videoTrack?.size
        if (!(vs?.width > 0 && vs?.height > 0 && w > 0 && h > 0)) return
        const scale = Math.min(w / vs.width, h / vs.height)
        const dw = vs.width * scale
        const dh = vs.height * scale
        setPict((cur) => {
          const next = { left: (w - dw) / 2, top: (h - dh) / 2, w: dw, h: dh }
          return cur && Math.abs(cur.top - next.top) < 1 && Math.abs(cur.w - next.w) < 1 ? cur : next
        })
      } catch {}
    }
    read()
    const t = setInterval(read, 500)
    return () => clearInterval(t)
  }, [playing])

  // Any interaction shows the controls and restarts the hide clock. They only
  // hide themselves while the film is actually rolling - a paused screen with
  // no controls reads as a hang.
  const poke = () => {
    setControlsOn(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      let rolling = false
      try { rolling = player.playing } catch {}
      if (rolling) setControlsOn(false)
    }, 3500)
  }
  const playingRef = useRef<typeof playing>(null)
  // The neighbours, in a ref as well as in state: the end-of-film listener is
  // installed once per film and would otherwise hold whatever nav was when the
  // film started, which is null - shell.navSet always lands a moment later.
  const navRef = useRef<typeof nav>(null)
  const lastPos = useRef(0)

  // SUBTITLES, both kinds behind one picker. Embedded text tracks ride the
  // native player (ExoPlayer reads them out of the file on direct play;
  // player.subtitleTrack selects one). External files - the host serves them
  // as WebVTT over the P2P connection - have NO path into a native player, so
  // they render as an RN overlay driven by the player's clock. The overlay is
  // mode-independent: direct play and the HLS transcode both carry the film's
  // own timeline, so one cue lookup serves both.
  const [subTracks, setSubTracks] = useState<any[]>([])
  const [subPicker, setSubPicker] = useState(false)
  const [activeSub, setActiveSub] = useState<string | null>(null)
  const [cueText, setCueText] = useState('')
  const cuesRef = useRef<Cue[]>([])
  // Where the bottom of the PICTURE is, in wrap coordinates. The video sits
  // letterboxed inside the wrap (contentFit contain), so anchoring cues to the
  // wrap floated them mid-black in portrait and mid-picture in landscape
  // (Tim, 2026-08-14: "in the middle of the screen instead of at the bottom").
  // Computed from the wrap's layout and the video track's own size.
  const wrapSizeRef = useRef({ w: 0, h: 0 })
  const [cueBottom, setCueBottom] = useState(24)
  // The boot effect's shellCall, reachable from render-time handlers.
  const shellCallRef = useRef<((method: string, args: any) => Promise<any>) | null>(null)
  // THE FORWARD BUFFER IS TIME-GOVERNED AND SMALL, and that is a revoke-latency
  // decision, not a tuning nicety. With ExoPlayer's defaults the SIZE thresholds
  // govern and it buffered minutes of film through the shim's windows - measured
  // 2026-08-14: a revoked screen kept playing 89 seconds from RAM. Time-governed
  // at 20 seconds, a revoke freezes the picture in at most about that, which is
  // what makes the wire's stream-cancel visible on the screen. The cost is a
  // shallower cushion against link hiccups, which 20 seconds still covers.
  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 5
    p.bufferOptions = {
      preferredForwardBufferDuration: 20,
      prioritizeTimeOverSizeThresholds: true
    }
  })

  // Worklet replies routed back to the WebView by id; worklet events forwarded
  // as __pearEvent. One buffer, newline-framed, exactly the suite convention.
  // What the shell needs to answer a lock-screen press on its own: which television,
  // which library, and the remote as last drawn. Held here rather than asked of the UI,
  // which may be frozen behind a locked screen at exactly the moment it is needed.
  const castRemote = useRef<any>(null)

  const feedWebView = (js: string) => {
    webref.current?.injectJavaScript(js + '; true;')
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      // The worklet's data dir. The device identity lives here, and it IS the
      // grant the host holds - wiping it means re-pairing. Refuse a relative
      // fallback: a phantom data dir presents as a paired phone that has
      // forgotten everything (the donor's measured failure).
      const docs = FileSystem.documentDirectory
      if (!docs) throw new Error('no documentDirectory - refusing to start the worklet on a relative data path')
      const dataDir = docs.replace('file://', '') + 'pearcinema'

      const worklet = new Worklet()
      const asset = Asset.fromModule(bundle)
      await asset.downloadAsync()
      const src = await FileSystem.readAsStringAsync(asset.localUri!, {
        encoding: FileSystem.EncodingType.Base64
      })

      // argv[1] is the PLATFORM - the shell is the only side that knows, and the
      // host's device list shows it to the operator deciding what to revoke.
      await worklet.start('/app.bundle', b4a.from(src, 'base64'), [dataDir, Platform.OS])
      if (cancelled) return

      workletRef.current = worklet
      const ipc = worklet.IPC
      ipcRef.current = ipc

      let buf = ''
      ipc.on('data', (data: Uint8Array) => {
        buf += b4a.toString(data)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let msg: any
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.event) {
            feedWebView(`window.__pearEvent && window.__pearEvent(${JSON.stringify(msg.event)}, ${JSON.stringify(msg.data ?? null)})`)
          } else if (msg.id != null && shellPending.current.has(msg.id)) {
            const done = shellPending.current.get(msg.id)!
            shellPending.current.delete(msg.id)
            done(msg)
          } else if (msg.id != null) {
            feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: msg.result ?? null, error: msg.error ?? null })})`)
          }
        }
      })

      // THE UI IS SERVED BY THE SHIM, NOT INJECTED AS A STRING. A string page with
      // a faked base URL loads <img> from the shim and then refuses <video> and
      // fetch() against the same URLs (measured on the TCL, 2026-08-14: MediaError
      // code 4 with zero requests). So the shell reads the HTML, hands it to the
      // worklet, and points the WebView at the shim's real origin.
      const uiHtml = await FileSystem.readAsStringAsync(
        (await Asset.fromModule(require('../assets/index.html')).downloadAsync()).localUri!
      )
      const shellCall = (method: string, args: any) => new Promise<any>((resolve) => {
        const id = shellId.current--
        shellPending.current.set(id, resolve)
        ipc.write(b4a.from(JSON.stringify({ id, method, args }) + '\n'))
      })
      shellCallRef.current = shellCall
      // The REAL decoder list, probed here because MediaCodecList is RN-side.
      // The worklet's mapper judges it; a null probe leaves the conservative
      // static declaration standing, which only costs the host engine time.
      const decoders = probeDecoders()
      // The raw VIDEO claims, logged verbatim: this is the per-device ledger of
      // what the chip SAYS, kept because the TCL proved a chip's word and a
      // playing film are different claims.
      console.warn('[shell] decoders', JSON.stringify(
        (decoders ?? []).filter((d) => d.mime.startsWith('video/'))
      ))
      shellCall('capabilities.declare', { probe: decoders }).then((r) => {
        console.warn('[shell] capabilities', JSON.stringify(r?.result ?? null))
      })

      let page = await shellCall('ui.page', { html: uiHtml })
      // The shim listens moments after boot; ask again until the port exists.
      while (!cancelled && !page?.result?.port) {
        await new Promise((r) => setTimeout(r, 150))
        page = await shellCall('ui.page', { html: uiHtml })
      }
      if (!cancelled) setUri(`http://127.0.0.1:${page.result.port}/`)
      SplashScreen.hideAsync().catch(() => {})
    })().catch((e) => {
      console.warn('[shell] boot failed', e?.message)
    })

    return () => {
      cancelled = true
      workletRef.current?.terminate()
    }
  }, [])

  // A pairing deep link (pear://pearcinema/pair?...) arrives here - cold start or
  // warm - and is handed to the UI, which owns the pairing screen.
  useEffect(() => {
    // Only PearCinema's own pairing links - the suite shares the pear:// scheme.
    // One console.log per link taken (LogBox eats console.warn in a bundled
    // debug build, so log is the level that reaches logcat): "did the intent
    // even arrive" is the first question every report about pairing raises.
    const forward = (url: string | null) => {
      if (!url || !url.startsWith('pear://pearcinema/pair')) return
      console.log('[shell] pair link stashed, rv=' + url.slice(30, 42))
      pendingPairLink = url
      // The fast path, for a delivery that did NOT remount us. If the router
      // remounts everything a beat later, the stash above is what survives and
      // the new mount's shell.pendingLink collect is what lands it.
      feedWebView(`window.__pearEvent && window.__pearEvent('pair-link', ${JSON.stringify(url)})`)
    }
    Linking.getInitialURL().then(forward).catch(() => {})
    const sub = Linking.addEventListener('url', (e) => forward(e.url))
    return () => sub.remove()
  }, [])

  // A BUTTON PRESSED ON THE LOCK SCREEN IS ANSWERED HERE, not by the web UI.
  //
  // It was the UI's job for one build, and the controls were on the lock screen and did
  // nothing until the app was brought back to the front (Tim, 2026-08-19, testing on the
  // Pixel). Android freezes a backgrounded WebView, so the press sat in a queue behind a
  // screen that was asleep. PearTune found the identical thing and moved cast control
  // into its shell for the identical reason (proposal 2026-08-02-cast-control-lives-in-
  // the-shell); this is that lesson arriving here.
  //
  // So the shell holds what it takes to act - which television, which library, how far
  // a skip goes - and talks to the worklet directly. The UI is TOLD afterwards rather
  // than asked first, and if it is asleep it catches up from the television's own state
  // when it wakes.
  useEffect(() => {
    const off = CastRemote.onAction((e) => {
      const held = castRemote.current
      const send = shellCallRef.current
      if (!held || !send) return
      const { entityId, libraryId, skipMs } = held
      const what = e?.action

      if (what === 'stop') {
        castRemote.current = null
        CastRemote.hide()
        send('cast.stop', { entityId, libraryId })
      } else if (what === 'play' || what === 'pause') {
        const paused = what === 'pause'
        // The notification flips NOW, off the press rather than off the answer: the
        // round trip to the host and on to the television is a second on a good day,
        // and a button that looks broken for a second gets pressed twice.
        held.info = { ...held.info, paused }
        CastRemote.show(held.info)
        send(paused ? 'cast.pause' : 'cast.resume', { entityId, libraryId })
      } else if (what === 'forward' || what === 'back') {
        // The answer carries where the film is going, so the card can say it without
        // asking a television that has not started the new stream yet.
        send('cast.seek', { entityId, libraryId, deltaMs: what === 'forward' ? skipMs : -skipMs })
          .then((r: any) => {
            const at = r?.result?.positionMs
            const still = castRemote.current
            if (at == null || !still) return
            still.info = { ...still.info, positionMs: at }
            CastRemote.show(still.info)
          })
          .catch(() => {})
      }

      // And the app hears about it, for whenever it is awake. Best effort by
      // construction - this is the path that was frozen.
      feedWebView(`window.__pearEvent && window.__pearEvent('cast:control', ${JSON.stringify(e)})`)
    })
    // Nothing is playing on this phone, so a remote left behind after the app goes
    // is a notification whose buttons answer to nobody.
    return () => { off(); CastRemote.hide() }
  }, [])

  // Android back: a running film closes first; then the UI unwinds its own
  // navigation; only a UI with nowhere left to go lets the system have it.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (playingRef.current) { stopPlayback(); return true }
      feedWebView('window.__pearBack && window.__pearBack()')
      return true
    })
    return () => sub.remove()
  }, [])

  // THE PLAYER MAY ROTATE; THE REST OF THE APP MAY NOT. The app is locked to
  // portrait in app.json, which locked the PLAYER too - a film could only ever
  // be a letterboxed band across a portrait screen, and the phone ignored being
  // turned (Tim, 2026-08-14: "it doesn't look right"). While a film runs the
  // orientation unlocks and the sensor decides; closing the player locks
  // portrait back. This deliberately does NOT use the native fullscreen
  // activity, which would rotate but is a separate screen the external-subtitle
  // overlay and the Subtitles button cannot follow into.
  useEffect(() => {
    if (playing) {
      ScreenOrientation.unlockAsync()
        .then(() => console.log('[shell] orientation unlocked'))
        .catch((e) => console.log('[shell] orientation unlock failed: ' + (e?.message || e)))
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        .then(() => console.log('[shell] orientation locked portrait'))
        .catch((e) => console.log('[shell] orientation lock failed: ' + (e?.message || e)))
    }
  }, [!!playing])

  useEffect(() => { navRef.current = nav }, [nav])

  // Position ticks flow INTO the UI, which owns every watch-state rule.
  useEffect(() => {
    playingRef.current = playing
    if (!playing) return
    lastPos.current = (playing.startMs || 0) / 1000
    const sub = player.addListener('timeUpdate', (e: any) => { lastPos.current = e.currentTime })
    const playSub = player.addListener('playingChange', (e: any) => setIsPlaying(!!e?.isPlaying))
    // THE NET FOR LYING CHIPS. A decoder that claimed a codec and then threw on
    // real frames surfaces here as a player error; the UI answers by asking for
    // the stream again with the honest self-description, and the host usually
    // decides transcode. Without this, an over-declaration is a black screen.
    const errSub = player.addListener('statusChange', (s: any) => {
      if (s?.status !== 'error') return
      const p = playingRef.current
      if (!p) return
      const payload = JSON.stringify({
        itemId: p.itemId,
        title: p.title,
        positionMs: Math.round(lastPos.current * 1000),
        error: String(s?.error?.message || '')
      })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:error', ${payload})`)
    })
    // THE FILM RAN OUT. Only ever the card, never the next episode straight
    // away - a cut from the last frame of one to the first of the next, with
    // no way to stop it, is the thing everybody turns autoplay off to escape.
    const endSub = player.addListener('playToEnd', () => {
      if (!playingRef.current) return
      const n = navRef.current
      if (!n?.next) return
      setUpNext(true)
      setLeft(n.autoplay ? NEXT_SECONDS : null)
      // The controls come back with it: cancelling should leave a player that
      // can be scrubbed or closed, not a bare frame.
      setControlsOn(true)
      clearTimeout(hideTimer.current)
    })
    const tick = setInterval(() => {
      const p = playingRef.current
      if (!p) return
      const payload = JSON.stringify({ itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:tick', ${payload})`)
    }, 15000)
    return () => { sub.remove(); playSub.remove(); errSub.remove(); endSub.remove(); clearInterval(tick) }
  }, [playing])

  // The countdown, one second at a time. It exists only while `left` is a
  // number, so cancelling and autoplay-off are the same state rather than two
  // flags to keep in step.
  useEffect(() => {
    if (left === null) return
    if (left <= 0) { navTo('next'); return }
    const t = setTimeout(() => setLeft((l) => (l === null ? null : l - 1)), 1000)
    return () => clearTimeout(t)
  }, [left])

  // The bar, started once when the countdown starts rather than nudged on each
  // tick - the dependency is whether one is running at all, not what second it
  // is on. Stopping it puts the bar back to full, so turning autoplay on again
  // starts a fresh ten seconds and the bar agrees with the number.
  useEffect(() => {
    const running = upNext && left !== null
    bar.stopAnimation()
    bar.setValue(1)
    if (!running) return
    const anim = Animated.timing(bar, {
      toValue: 0,
      duration: NEXT_SECONDS * 1000,
      easing: Easing.linear,
      useNativeDriver: true
    })
    anim.start()
    return () => anim.stop()
  }, [upNext, left !== null])

  // The time bar's clock: polled only while the controls are actually on
  // screen - a hidden bar does not need a heartbeat.
  useEffect(() => {
    if (!playing || !controlsOn) return
    const read = () => {
      try { setClock({ pos: player.currentTime || 0, dur: player.duration || 0 }) } catch {}
    }
    read()
    const t = setInterval(read, 500)
    return () => clearInterval(t)
  }, [playing, controlsOn])

  const stopPlayback = () => {
    const p = playingRef.current
    if (p) {
      const payload = JSON.stringify({ itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:closed', ${payload})`)
    }
    try { player.pause() } catch {}
    setPlaying(null)
    setNav(null)
    setUpNext(false); setLeft(null)
    setSubTracks([]); setSubPicker(false); setActiveSub(null); setCueText('')
    cuesRef.current = []
    clearTimeout(hideTimer.current)
    setControlsOn(true)
    setScrub(null)
  }

  const togglePlay = () => {
    try { isPlaying ? player.pause() : player.play() } catch {}
    poke()
  }

  const jumpBy = (seconds: number) => {
    try { player.seekBy(seconds) } catch {}
    poke()
  }

  // Touch on the time bar: the fill follows the finger, the seek fires once on
  // release. locationX is relative to the bar through the whole gesture.
  const scrubAt = (x: number) => {
    setScrub(Math.max(0, Math.min(1, x / (seekBarWidth.current || 1))))
    poke()
  }
  const scrubEnd = () => {
    setScrub((s) => {
      if (s !== null && clock.dur > 0) {
        try { player.currentTime = s * clock.dur } catch {}
        setClock((c) => ({ ...c, pos: s * c.dur }))
      }
      return null
    })
    poke()
  }

  const fmtTime = (s: number) => {
    const t = Math.max(0, Math.round(s || 0))
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const sec = t % 60
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
    return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0')
  }

  // Previous/Next tapped: pause where we are and hand the intent to the UI,
  // which knows the neighbours and answers with a fresh shell.play. The pause
  // matters - the swap takes a host round trip and old frames playing on under
  // new buttons reads as the tap not working.
  const navTo = (direction: 'prev' | 'next') => {
    const p = playingRef.current
    if (!p) return
    try { player.pause() } catch {}
    const payload = JSON.stringify({ direction, itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
    feedWebView(`window.__pearEvent && window.__pearEvent('player:nav', ${payload})`)
  }

  // Hand the film to a television from inside the player. The whole point is
  // that it carries the MINUTE: deciding to cast forty minutes in should not
  // mean starting the film again. The picker itself lives in the web UI, which
  // is what knows the televisions, so this closes the player and hands over -
  // and stopPlayback's own player:closed is what writes the resume, so the
  // position is safe even if the picker is then dismissed.
  const castFromPlayer = () => {
    const p = playingRef.current
    if (!p) return
    try { player.pause() } catch {}
    const payload = JSON.stringify({
      itemId: p.itemId, title: p.title || '', positionMs: Math.round(lastPos.current * 1000)
    })
    feedWebView(`window.__pearEvent && window.__pearEvent('player:cast', ${payload})`)
    stopPlayback()
  }

  // The overlay's clock: the active cue, looked up from the player's own time a
  // few times a second. Only ticks while an external track is showing.
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      if (!cuesRef.current.length) return
      let at = 0
      try { at = player.currentTime } catch { return }
      const cue = cuesRef.current.find((c) => at >= c.start && at <= c.end)
      setCueText((cur) => {
        const next = cue ? cue.text : ''
        return cur === next ? cur : next
      })
      // Pin the cue just inside the picture's bottom edge: letterbox height is
      // (wrap - displayed video) / 2, from contain-fit arithmetic.
      try {
        const { w, h } = wrapSizeRef.current
        const vs: any = player.videoTrack?.size
        if (vs?.width > 0 && vs?.height > 0 && w > 0 && h > 0) {
          const scale = Math.min(w / vs.width, h / vs.height)
          const bottom = Math.max(16, (h - vs.height * scale) / 2 + 16)
          setCueBottom((cur) => (Math.abs(cur - bottom) > 1 ? bottom : cur))
        }
      } catch {}
    }, 300)
    return () => clearInterval(t)
  }, [playing])

  // A burn choice restarts the film through the UI - the pictures have to be
  // pressed into the frames by the host, which is a different stream. Pausing
  // first, same reasoning as navTo: old frames under a made choice read as the
  // tap not working. `subtitleId: null` is the un-burn, also a restart, because
  // a burned frame cannot be un-burned in place.
  const requestBurn = (subtitleId: string | null) => {
    const p = playingRef.current
    if (!p) return
    try { player.pause() } catch {}
    const payload = JSON.stringify({ itemId: p.itemId, subtitleId, title: p.title, positionMs: Math.round(lastPos.current * 1000) })
    feedWebView(`window.__pearEvent && window.__pearEvent('player:burn', ${payload})`)
  }

  const chooseSubtitle = async (kind: 'off' | 'embedded' | 'external' | 'burn', track?: any) => {
    setSubPicker(false)
    cuesRef.current = []
    setCueText('')
    if (kind === 'burn') {
      setActiveSub('burn:' + track.id)
      try { player.subtitleTrack = null } catch {}
      requestBurn(track.id)
      return
    }
    if (kind === 'off') {
      const wasBurn = !!activeSub?.startsWith('burn:')
      setActiveSub(null)
      try { player.subtitleTrack = null } catch {}
      if (wasBurn) requestBurn(null)
      return
    }
    if (kind === 'embedded') {
      setActiveSub('emb:' + (track?.id ?? track?.label ?? ''))
      try { player.subtitleTrack = track } catch {}
      return
    }
    // External: the host's WebVTT, rendered by the overlay. The native track is
    // switched off so two sets of subtitles cannot fight over the picture.
    try { player.subtitleTrack = null } catch {}
    const p = playingRef.current
    if (!p) return
    setActiveSub('ext:' + track.id)
    const out = await shellCallRef.current?.('subtitle.get', { itemId: p.itemId, subtitleId: track.id })
    if (playingRef.current?.itemId !== p.itemId) return
    cuesRef.current = parseVtt(out?.result?.vtt || '')
    if (!cuesRef.current.length) setActiveSub(null)
  }

  // WebView -> worklet: the other half of the bridge.
  const onMessage = (event: any) => {
    let msg: any
    try { msg = JSON.parse(event.nativeEvent.data) } catch { return }

    // A handful of methods are the SHELL's, not the worklet's.
    if (msg.method === 'shell.exit') { BackHandler.exitApp(); return }
    if (msg.method === 'shell.play') {
      const { itemId, url, title, startMs, burnedSubtitleId, canCast } = msg.args || {}
      // The skin rides fresh plays explicitly; retries, burn restarts and
      // episode hops inherit the one already worn.
      const skin = msg.args?.skin ?? playingRef.current?.skin ?? 'off'
      // A DIFFERENT item resets the episode buttons until the UI re-declares
      // them. The same item replayed (the lying-chip transcode retry) keeps
      // its buttons - the neighbours have not changed.
      if (itemId !== playingRef.current?.itemId) setNav(null)
      // Whatever this play is - a fresh film, the next episode, a transcode
      // retry - the card belongs to the one that just finished.
      setUpNext(false); setLeft(null)
      // canCast rides the play rather than being asked for here: only the web UI
      // knows whether this device holds owner scope and whether the library it is
      // watching has a television configured at all. A button that opens an empty
      // picker is worse than no button.
      setPlaying({ itemId, url, title: title || '', startMs, skin, canCast: !!canCast })
      // A new film starts with no subtitles chosen and a fresh track list -
      // unless this play IS the burned restart, whose choice survives it.
      setSubTracks([]); setSubPicker(false); setCueText('')
      setActiveSub(burnedSubtitleId ? 'burn:' + burnedSubtitleId : null)
      cuesRef.current = []
      shellCallRef.current?.('subtitle.list', { itemId })
        .then((r) => setSubTracks((r?.result?.items || []).filter((t: any) => t.playable || t.burnable)))
        .catch(() => {})
      try {
        player.replace({ uri: url })
        if (startMs > 0) player.currentTime = startMs / 1000
        player.play()
      } catch (e: any) {
        console.warn('[shell] play failed', e?.message)
      }
      setIsPlaying(true)
      setClock({ pos: (startMs || 0) / 1000, dur: 0 })
      setScrub(null)
      poke()
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.stop') {
      stopPlayback()
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.navSet') {
      // Guarded by item: an answer that arrives after the person already moved
      // on to something else must not put the wrong show's buttons up.
      if (msg.args?.itemId === playingRef.current?.itemId) {
        setNav({
          hasPrev: !!msg.args?.hasPrev,
          hasNext: !!msg.args?.hasNext,
          // Absent means on, matching the setting's own default - an older
          // page that does not send it must not silently turn it off.
          autoplay: msg.args?.autoplayNext !== false,
          next: msg.args?.next || null
        })
      }
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.haptic') {
      const k = msg.args?.kind
      ;(async () => {
        try {
          if (k === 'medium') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
          else if (k === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          else if (k === 'warn') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          else await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        } catch (e: any) { console.log('[shell] haptic failed: ' + e?.message) }
      })()
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    // THE PHONE AS A REMOTE, on the lock screen. Nothing is playing here - the film
    // is on a television - so this is not expo-video's now-playing notification but a
    // media session of our own, published while a cast is live and cancelled with it.
    // The web UI owns the cast; the shell only draws the remote and hands the buttons
    // back (Tim, 2026-08-19: answering a message meant unlocking, opening the app and
    // waiting for it to come back before the room could be paused).
    if (msg.method === 'shell.castRemote') {
      const a = msg.args || {}
      if (a.show) {
        castRemote.current = {
          entityId: a.entityId,
          libraryId: a.libraryId,
          skipMs: Number(a.skipMs) || 30000,
          info: {
            title: a.title || 'Playing',
            subtitle: a.subtitle || '',
            artUrl: a.artUrl || null,
            paused: !!a.paused,
            canSkip: a.canSkip !== false,
            positionMs: Number(a.positionMs) || 0,
            durationMs: Number(a.durationMs) || 0
          }
        }
        CastRemote.show(castRemote.current.info)
      } else {
        castRemote.current = null
        CastRemote.hide()
      }
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.openUrl') {
      Linking.openURL(msg.args?.url).catch(() => {})
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.canOpenURL') {
      Linking.canOpenURL(msg.args?.url ?? '').then((can) => {
        feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { can: !!can }, error: null })})`)
      }).catch(() => {
        feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { can: false }, error: null })})`)
      })
      return
    }
    if (msg.method === 'shell.clipboard') {
      Clipboard.setStringAsync(String(msg.args?.text ?? '')).catch(() => {})
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.share') {
      Share.share({ message: String(msg.args?.text ?? '') }).catch(() => {})
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.pendingLink') {
      // Collect semantics: hand the link over ONCE and clear it, or a taken
      // link would reopen the pairing screen on every later remount.
      const link = pendingPairLink
      pendingPairLink = null
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: link, error: null })})`)
      return
    }
    // The QR scanner runs IN the WebView (getUserMedia + jsQR, PearTune's
    // shape), but the WebView can only use a camera the APP holds the runtime
    // permission for. The UI asks here before opening the scanner; denial is
    // not an error - the scanner shows its own sentence and the paste path
    // still works.
    if (msg.method === 'shell.cameraPermission') {
      ;(async () => {
        let granted = true
        try {
          if (Platform.OS === 'android') {
            const r = await PermissionsAndroid.request('android.permission.CAMERA' as any)
            granted = r === PermissionsAndroid.RESULTS.GRANTED
          }
        } catch {
          granted = false
        }
        feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { granted }, error: null })})`)
      })()
      return
    }

    // WHAT THE PAGE JUST PAINTED, so the strip the shell owns matches it. The page
    // resolves the theme (src/ui/theme.js) and tells us; without this the shell's own
    // background is a hardcoded near-black, which on a LIGHT phone is a black band
    // between the status bar and the page. Seen the moment PearCinema first ran on an
    // iPhone Simulator, 2026-08-20 - the Simulator boots light and every Android phone
    // this had been tried on was dark.
    if (msg.method === 'theme') {
      const scheme = msg.args?.scheme === 'light' ? 'light' : 'dark'
      setPageTheme(scheme)
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { scheme }, error: null })})`)
      return
    }

    const ipc = ipcRef.current
    if (!ipc) {
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: null, error: 'worklet not ready' })})`)
      return
    }
    ipc.write(b4a.from(JSON.stringify(msg) + '\n'))
  }

  // Android 15 draws the app edge-to-edge, so without this the WebView's header
  // sits under the status bar (Tim, 2026-08-15: nothing may collide with the
  // notifications bar). The shell pads; the page never needs to know.
  const insets = useSafeAreaInsets()

  // THE OS's ANSWER IS THE AUTHORITY, not the WebView's own prefers-color-scheme: an
  // Android WebView does not reliably track the app's night mode, which is why
  // src/ui/theme.js reads `window.__pearColorScheme` first and only falls back to
  // matchMedia. Nothing was setting it here.
  const osScheme = useColorScheme() === 'light' ? 'light' : 'dark'
  // What the page says it painted, once it has painted. Until then the OS's answer is
  // the best guess available and is right for everybody who has not chosen otherwise.
  const [pageTheme, setPageTheme] = useState<'light' | 'dark' | null>(null)
  const shellBg = (pageTheme || osScheme) === 'light' ? LIGHT_BG : DARK_BG

  // AND THE WINDOW BEHIND EVERYTHING, which is not ours to paint with a style. The root
  // view sits inside a system-coloured window - white on a light phone, black on a dark
  // one - and that shows in the strip above our own View, under the status bar. Painting
  // the View alone left a white line over a cream page and a black one over a dark page,
  // which is the same bug twice at two brightnesses.
  useEffect(() => { SystemUI.setBackgroundColorAsync(shellBg).catch(() => {}) }, [shellBg])

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: shellBg }]}>
      {uri && (
        <WebView
          ref={webref}
          source={{ uri }}
          originWhitelist={['*']}
          onMessage={onMessage}
          // Before the page's first line runs, so its very first paint resolves 'system'
          // against the phone rather than against the WebView's guess.
          injectedJavaScriptBeforeContentLoaded={`window.__pearColorScheme=${JSON.stringify(osScheme)};true;`}
          // The player IS an HTML5 <video> pointed at the loopback shim, so media
          // must play inline and without a user-gesture fight.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          // The pairing QR scanner runs in the WebView via getUserMedia - the
          // page's origin (http://127.0.0.1) is a trustworthy origin, so the
          // camera API exists; these two hand the WebView the camera once the
          // app itself holds the runtime permission (shell.cameraPermission).
          mediaCapturePermissionGrantType='grant'
          onPermissionRequest={(ev: any) => { try { ev?.grant?.(ev.resources) } catch {} }}
          style={styles.web}
        />
      )}

      {playing && (
        <View style={styles.playerOverlay}>
          <View
            style={styles.videoWrap}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout
              wrapSizeRef.current = { w: width, h: height }
            }}
          >
            <VideoView
              style={styles.video}
              player={player}
              // OFF on purpose - see the controls note above. Everything the
              // native row offered is drawn below in one design.
              nativeControls={false}
              allowsFullscreen={false}
              contentFit='contain'
            />

            {/* THE TAP CATCHER, a SIBLING stacked above the video - not a
                parent around it. Two failed attempts are buried here (Tim's
                Pixel field reports, both times "taps do nothing once the
                controls hide"): a Pressable WRAPPING the video never saw the
                taps its child swallowed, and pointerEvents='none' ON the video
                is forwarded by expo-video but ignored by its Android view, so
                it only looked fixed on a device that never had the bug. A
                plain RN Pressable layered on top depends on nothing native -
                the video simply never receives a touch again. */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => (controlsOn ? setControlsOn(false) : poke())}
            />
            {/* THE SKINS - purely cosmetic dressings pinned to the PICTURE's
                edges (Tim, 2026-08-15; PearTune's Winamp-toggle pattern).
                The 35mm strips are drawn, not an asset: a dark band with a
                row of light sprocket holes at each edge. The theater row is
                a silhouette image across the picture's bottom. Deaf to touch
                like everything else that is not a control. */}
            {playing.skin === 'film' && pict && (() => {
              const stripH = Math.max(14, Math.min(30, pict.h * 0.07))
              const holes = Array.from({ length: Math.max(6, Math.round(pict.w / 46)) }, (_, i) => (
                <View key={i} style={[styles.sprocket, { width: stripH * 0.52, height: stripH * 0.58 }]} />
              ))
              return (
                <>
                  <View pointerEvents='none' style={[styles.filmStrip, { left: pict.left, top: pict.top, width: pict.w, height: stripH }]}>{holes}</View>
                  <View pointerEvents='none' style={[styles.filmStrip, { left: pict.left, top: pict.top + pict.h - stripH, width: pict.w, height: stripH }]}>{holes}</View>
                </>
              )
            })()}
            {playing.skin === 'mst3k' && pict && (
              <Image
                pointerEvents='none'
                source={require('../assets/mst3k-silhouettes.png')}
                style={{
                  position: 'absolute',
                  left: pict.left,
                  width: pict.w,
                  height: pict.w * (300 / 1600),
                  top: pict.top + pict.h - pict.w * (300 / 1600)
                }}
                resizeMode='stretch'
              />
            )}

            {!!cueText && (
              <View pointerEvents='none' style={[styles.cueWrap, { bottom: cueBottom }]}>
                <Text style={styles.cue}>{cueText}</Text>
              </View>
            )}

            {/* box-none: the chrome rows catch their own taps, the empty
                middle falls through to the show/hide Pressable above. */}
            {controlsOn && (
              <View style={styles.controls} pointerEvents='box-none'>
                <View style={styles.ctlTop}>
                  <Pressable onPress={stopPlayback} style={styles.ctlBtn} hitSlop={8}>
                    <MaterialIcons name='arrow-back' size={26} color='#efe9df' />
                  </Pressable>
                  <Text style={styles.title} numberOfLines={1}>{playing.title}</Text>
                  {playing.canCast && (
                    <Pressable onPress={castFromPlayer} style={styles.ctlBtn} hitSlop={8} accessibilityLabel='Play this on a television'>
                      <MaterialIcons name='cast' size={26} color='#efe9df' />
                    </Pressable>
                  )}
                  <Pressable onPress={() => { poke(); setSubPicker(true) }} style={styles.ctlBtn} hitSlop={8}>
                    <MaterialIcons name='closed-caption' size={26} color={activeSub ? '#e2a13d' : '#efe9df'} />
                  </Pressable>
                </View>

                <View style={styles.ctlCenter} pointerEvents='box-none'>
                  {nav && (
                    <Pressable disabled={!nav.hasPrev} onPress={() => navTo('prev')} style={[styles.ctlBtn, !nav.hasPrev && styles.ctlOff]} hitSlop={8}>
                      <MaterialIcons name='skip-previous' size={40} color='#efe9df' />
                    </Pressable>
                  )}
                  <Pressable onPress={() => jumpBy(-10)} style={styles.ctlBtn} hitSlop={8}>
                    <MaterialIcons name='replay-10' size={34} color='#efe9df' />
                  </Pressable>
                  <Pressable onPress={togglePlay} style={styles.ctlBtn} hitSlop={12}>
                    <MaterialIcons name={isPlaying ? 'pause-circle-filled' : 'play-circle-filled'} size={64} color='#efe9df' />
                  </Pressable>
                  <Pressable onPress={() => jumpBy(10)} style={styles.ctlBtn} hitSlop={8}>
                    <MaterialIcons name='forward-10' size={34} color='#efe9df' />
                  </Pressable>
                  {nav && (
                    <Pressable disabled={!nav.hasNext} onPress={() => navTo('next')} style={[styles.ctlBtn, !nav.hasNext && styles.ctlOff]} hitSlop={8}>
                      <MaterialIcons name='skip-next' size={40} color='#efe9df' />
                    </Pressable>
                  )}
                </View>

                <View style={styles.ctlBottom}>
                  <Text style={styles.ctlTime}>{fmtTime(scrub !== null ? scrub * clock.dur : clock.pos)}</Text>
                  <View
                    style={styles.seekWrap}
                    onLayout={(e) => { seekBarWidth.current = e.nativeEvent.layout.width }}
                    // The bar CLAIMS the gesture, or the tap-to-hide Pressable
                    // underneath fires on release and the controls vanish the
                    // moment a scrub ends.
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={(e) => scrubAt(e.nativeEvent.locationX)}
                    onResponderMove={(e) => scrubAt(e.nativeEvent.locationX)}
                    onResponderRelease={scrubEnd}
                    onResponderTerminate={scrubEnd}
                  >
                    <View style={styles.seekTrack}>
                      <View style={[styles.seekFill, { width: `${Math.round(100 * (scrub !== null ? scrub : (clock.dur > 0 ? Math.min(1, clock.pos / clock.dur) : 0)))}%` }]} />
                    </View>
                  </View>
                  <Text style={styles.ctlTime}>{fmtTime(clock.dur)}</Text>
                </View>
              </View>
            )}
          </View>

          {/* THE SCRIM DISMISSES AND THE TRACKS SCROLL (Tim, 2026-08-17): a
              real film carries a dozen tracks and the card grew taller than
              the player with no way to reach the rest - and no way out short
              of choosing one. The card swallows its own taps so only a tap
              OUTSIDE it closes; the header and Close stay pinned while the
              tracks scroll between them. */}
          {subPicker && (
            <Pressable style={styles.subPicker} onPress={() => setSubPicker(false)}>
              <Pressable style={styles.subCard} onPress={() => {}}>
                <Text style={styles.subHead}>Subtitles</Text>
                <ScrollView style={styles.subScroll}>
                <Pressable style={styles.subRow} onPress={() => chooseSubtitle('off')}>
                  <Text style={[styles.subTxt, !activeSub && styles.subOn]}>Off</Text>
                </Pressable>
                {(() => {
                  // Discs label tracks lazily - A New Hope carries TWO picture
                  // tracks both called ENG: the full dialogue and an alien-
                  // speech-only one that looks broken outside those scenes
                  // (Tim's field report, 2026-08-15). Identical labels get
                  // numbered so the rows are at least tellable apart.
                  const totals: Record<string, number> = {}
                  const seen: Record<string, number> = {}
                  for (const t of subTracks) {
                    const base = t.title || t.language || 'Subtitles'
                    totals[base] = (totals[base] || 0) + 1
                  }
                  const labelFor = (t: any) => {
                    const base = t.title || t.language || 'Subtitles'
                    seen[base] = (seen[base] || 0) + 1
                    return totals[base] > 1 ? `${base} ${seen[base]}` : base
                  }
                  return subTracks.map((t: any) => (
                    t.burnable ? (
                      // An image track the host can press into the picture. The
                      // choice restarts the film as a burned stream - the label
                      // says so, since a beat of buffering follows the tap.
                      <Pressable key={t.id} style={styles.subRow} onPress={() => chooseSubtitle('burn', t)}>
                        <Text style={[styles.subTxt, activeSub === 'burn:' + t.id && styles.subOn]}>
                          {labelFor(t) + ' (pressed into the picture)'}
                        </Text>
                      </Pressable>
                    ) : (
                      <Pressable key={t.id} style={styles.subRow} onPress={() => chooseSubtitle('external', t)}>
                        <Text style={[styles.subTxt, activeSub === 'ext:' + t.id && styles.subOn]}>
                          {labelFor(t) + (t.external ? '' : ' (in the file)')}
                        </Text>
                      </Pressable>
                    )
                  ))
                })()}
                {(() => {
                  // The tracks ExoPlayer read out of the file itself - present on
                  // direct play, absent on a transcode (the segments carry none).
                  let embedded: any[] = []
                  try { embedded = player.availableSubtitleTracks || [] } catch {}
                  return embedded.map((t: any, i: number) => (
                    <Pressable key={'emb' + i} style={styles.subRow} onPress={() => chooseSubtitle('embedded', t)}>
                      <Text style={[styles.subTxt, activeSub === 'emb:' + (t?.id ?? t?.label ?? '') && styles.subOn]}>
                        {(t.label || t.language || `Track ${i + 1}`) + ' (in the file)'}
                      </Text>
                    </Pressable>
                  ))
                })()}
                {subTracks.length === 0 && (
                  <Text style={styles.subNone}>No subtitle files for this one - anything listed above came from inside the file.</Text>
                )}
                </ScrollView>
                <Pressable style={styles.subRow} onPress={() => setSubPicker(false)}>
                  <Text style={styles.subTxt}>Close</Text>
                </Pressable>
              </Pressable>
            </Pressable>
          )}

          {/* PLAYING NEXT. Over the last frame, and the only thing on screen
              that acts by itself - which is why the count is shown the whole
              time it runs and why Cancel is the same size as Play now. */}
          {upNext && nav?.next && (
            <View style={styles.nextWrap}>
              <View style={styles.nextCard}>
                <Text style={styles.nextEyebrow}>PLAYING NEXT</Text>
                <View style={styles.nextRow}>
                  {!!nav.next.artUrl && (
                    <Image source={{ uri: nav.next.artUrl }} style={styles.nextArt} resizeMode='cover' />
                  )}
                  <View style={styles.nextMeta}>
                    <Text style={styles.nextTitle} numberOfLines={1}>
                      {nav.next.seriesTitle || nav.next.title}
                    </Text>
                    <Text style={styles.nextSub} numberOfLines={1}>
                      {[nav.next.label, nav.next.title].filter(Boolean).join(' - ')}
                    </Text>
                    {!!nav.next.runtime && (
                      <Text style={styles.nextHint}>{Math.round(nav.next.runtime / 60)} min</Text>
                    )}
                    {!!nav.next.overview && (
                      <Text style={styles.nextOverview} numberOfLines={3}>{nav.next.overview}</Text>
                    )}
                  </View>
                </View>

                <View style={styles.nextActs}>
                  <Pressable style={styles.nextBtn} onPress={() => navTo('next')}>
                    <MaterialIcons name='play-arrow' size={20} color='#1c1305' />
                    <Text style={styles.nextBtnTxt}>
                      {left === null ? 'Play now' : `Play now (${Math.max(0, left)})`}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.nextGhost}
                    onPress={() => { setLeft(null); setUpNext(false); poke() }}
                  >
                    <Text style={styles.nextGhostTxt}>Cancel</Text>
                  </Pressable>
                </View>

                {/* The countdown, drawn rather than only counted: a number
                    alone does not say how much of the wait is left at a
                    glance. Nothing is here at all when nothing is running. */}
                {left !== null && (
                  <View style={styles.nextTrack}>
                    <Animated.View style={[styles.nextFill, { transform: [{ scaleX: bar }] }]} />
                  </View>
                )}

                <Pressable
                  style={styles.nextAuto}
                  onPress={() => {
                    const on = !nav.autoplay
                    setNav((n) => (n ? { ...n, autoplay: on } : n))
                    setLeft(on ? NEXT_SECONDS : null)
                    // The web UI saves it, so the card and the Settings switch
                    // are one preference rather than two that drift.
                    feedWebView(`window.__pearEvent && window.__pearEvent('player:autoplay', ${JSON.stringify({ on })})`)
                  }}
                >
                  <MaterialIcons
                    name={nav.autoplay ? 'check-box' : 'check-box-outline-blank'}
                    size={20}
                    color={nav.autoplay ? '#e2a13d' : '#a2947d'}
                  />
                  <Text style={styles.nextAutoTxt}>Autoplay</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK_BG },
  web: { flex: 1 },
  playerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  controls: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'space-between' },
  ctlTop: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 40, paddingHorizontal: 14, paddingBottom: 6 },
  ctlCenter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22 },
  ctlBottom: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingBottom: 18 },
  ctlBtn: { padding: 4 },
  ctlOff: { opacity: 0.35 },
  filmStrip: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-evenly', backgroundColor: 'rgba(8,8,8,0.92)'
  },
  sprocket: { backgroundColor: 'rgba(240,234,220,0.85)', borderRadius: 3 },
  ctlTime: { color: '#efe9df', fontVariant: ['tabular-nums'], fontSize: 12 },
  // The touch target is much taller than the painted track, or a moving thumb
  // is impossible to catch mid-film.
  seekWrap: { flex: 1, height: 32, justifyContent: 'center' },
  seekTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(239,233,223,0.3)', overflow: 'hidden' },
  seekFill: { height: 4, backgroundColor: '#e2a13d' },
  title: { color: '#efe9df', flex: 1 },
  videoWrap: { flex: 1 },
  video: { flex: 1 },
  // The external-subtitle overlay: pinned to the PICTURE's bottom edge (the
  // bottom offset is computed from the letterbox), never touchable, readable
  // on any picture.
  cueWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  cue: {
    color: '#fff', fontSize: 16, lineHeight: 22, textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 6, overflow: 'hidden'
  },
  subPicker: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center', padding: 24
  },
  // PLAYING NEXT. The scrim is nearly opaque - the episode is over, so there is
  // nothing under it worth seeing through.
  nextWrap: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center', justifyContent: 'center', padding: 20
  },
  nextCard: {
    width: '100%', maxWidth: 560,
    backgroundColor: '#1a1712', borderColor: '#2e2820', borderWidth: 1,
    borderRadius: 14, padding: 16, gap: 12
  },
  nextEyebrow: { color: '#a2947d', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  nextRow: { flexDirection: 'row', gap: 14 },
  nextArt: { width: 74, height: 111, borderRadius: 8, backgroundColor: '#0f0d0a' },
  nextMeta: { flex: 1, gap: 2 },
  nextTitle: { color: '#efe9df', fontSize: 19, fontWeight: '600' },
  nextSub: { color: '#efe9df', fontSize: 14, fontWeight: '600' },
  nextHint: { color: '#a2947d', fontSize: 12 },
  nextOverview: { color: '#a2947d', fontSize: 13, lineHeight: 18, marginTop: 6 },
  nextActs: { flexDirection: 'row', gap: 10 },
  nextBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: '#e2a13d', borderRadius: 10, paddingVertical: 11
  },
  nextBtnTxt: { color: '#1c1305', fontWeight: '700' },
  nextGhost: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    borderColor: '#2e2820', borderWidth: 1, borderRadius: 10, paddingVertical: 11
  },
  nextGhostTxt: { color: '#efe9df', fontWeight: '600' },
  nextTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(239,233,223,0.18)', overflow: 'hidden' },
  // Full width, emptied by scaling from its LEFT edge - scaleX is about the
  // centre by default, which would shrink the bar towards its middle.
  nextFill: { height: 3, width: '100%', backgroundColor: '#e2a13d', transformOrigin: 'left' },
  nextAuto: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nextAutoTxt: { color: '#a2947d', fontSize: 13 },
  subCard: {
    backgroundColor: '#1a1712', borderColor: '#2e2820', borderWidth: 1,
    borderRadius: 12, padding: 8, alignSelf: 'stretch', maxWidth: 420,
    maxHeight: '80%'
  },
  subScroll: { flexGrow: 0 },
  subHead: { color: '#efe9df', fontWeight: '700', fontSize: 16, padding: 10 },
  subRow: { paddingVertical: 12, paddingHorizontal: 10, borderTopWidth: 1, borderTopColor: '#241f18' },
  subTxt: { color: '#efe9df' },
  subOn: { color: '#e2a13d', fontWeight: '700' },
  subNone: { color: '#8f8778', fontSize: 12, padding: 10 }
})
