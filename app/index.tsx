// The PearCinema shell: boots the Bare worklet, bridges it to the WebView UI, and
// otherwise stays out of the way.
//
// PearTune's shape (its shell is the donor and carries the scars): the worklet is
// the P2P backend, the WebView is the whole interface, and this file is the only
// place the two meet. Requests ride { id, method, args } both hops - WebView to
// shell over postMessage, shell to worklet over BareKit IPC - and replies come
// back on the same ids. Events push the other way as { event, data }.

import { useEffect, useRef, useState } from 'react'
import { BackHandler, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
// expo-linking, NOT react-native's Linking: on the new architecture the RN
// module's warm 'url' event never fires, so a pairing link tapped while the
// app was running arrived nowhere (measured on the TCL, 2026-08-14 - the
// second half of the pairing-link gap; the donor shell uses expo-linking too).
import * as Linking from 'expo-linking'
import { WebView } from 'react-native-webview'
import { VideoView, useVideoPlayer } from 'expo-video'
import { Worklet } from 'react-native-bare-kit'
import * as FileSystem from 'expo-file-system/legacy'
import { Asset } from 'expo-asset'
import * as SplashScreen from 'expo-splash-screen'
import b4a from 'b4a'
import { probe as probeDecoders } from '../modules/decoder-probe'

const bundle = require('../assets/bare-universal.bundle')

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
  const [playing, setPlaying] = useState<{ itemId: string, url: string, title: string, startMs?: number } | null>(null)
  const playingRef = useRef<typeof playing>(null)
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

  // Position ticks flow INTO the UI, which owns every watch-state rule.
  useEffect(() => {
    playingRef.current = playing
    if (!playing) return
    lastPos.current = (playing.startMs || 0) / 1000
    const sub = player.addListener('timeUpdate', (e: any) => { lastPos.current = e.currentTime })
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
    const tick = setInterval(() => {
      const p = playingRef.current
      if (!p) return
      const payload = JSON.stringify({ itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:tick', ${payload})`)
    }, 15000)
    return () => { sub.remove(); errSub.remove(); clearInterval(tick) }
  }, [playing])

  const stopPlayback = () => {
    const p = playingRef.current
    if (p) {
      const payload = JSON.stringify({ itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:closed', ${payload})`)
    }
    try { player.pause() } catch {}
    setPlaying(null)
    setSubTracks([]); setSubPicker(false); setActiveSub(null); setCueText('')
    cuesRef.current = []
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
    }, 300)
    return () => clearInterval(t)
  }, [playing])

  const chooseSubtitle = async (kind: 'off' | 'embedded' | 'external', track?: any) => {
    setSubPicker(false)
    cuesRef.current = []
    setCueText('')
    if (kind === 'off') {
      setActiveSub(null)
      try { player.subtitleTrack = null } catch {}
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
      const { itemId, url, title, startMs } = msg.args || {}
      setPlaying({ itemId, url, title: title || '', startMs })
      // A new film starts with no subtitles chosen and a fresh track list.
      setSubTracks([]); setSubPicker(false); setActiveSub(null); setCueText('')
      cuesRef.current = []
      shellCallRef.current?.('subtitle.list', { itemId })
        .then((r) => setSubTracks((r?.result?.items || []).filter((t: any) => t.playable)))
        .catch(() => {})
      try {
        player.replace({ uri: url })
        if (startMs > 0) player.currentTime = startMs / 1000
        player.play()
      } catch (e: any) {
        console.warn('[shell] play failed', e?.message)
      }
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: { ok: true }, error: null })})`)
      return
    }
    if (msg.method === 'shell.stop') {
      stopPlayback()
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

    const ipc = ipcRef.current
    if (!ipc) {
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: null, error: 'worklet not ready' })})`)
      return
    }
    ipc.write(b4a.from(JSON.stringify(msg) + '\n'))
  }

  return (
    <View style={styles.root}>
      {uri && (
        <WebView
          ref={webref}
          source={{ uri }}
          originWhitelist={['*']}
          onMessage={onMessage}
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
          <View style={styles.playerBar}>
            <Pressable onPress={stopPlayback} style={styles.backBtn}>
              <Text style={styles.backTxt}>‹ Back</Text>
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>{playing.title}</Text>
            <Pressable onPress={() => setSubPicker(true)} style={styles.backBtn}>
              <Text style={styles.backTxt}>Subtitles</Text>
            </Pressable>
          </View>
          <View style={styles.videoWrap}>
            <VideoView
              style={styles.video}
              player={player}
              nativeControls
              allowsFullscreen
              contentFit='contain'
            />
            {!!cueText && (
              <View pointerEvents='none' style={styles.cueWrap}>
                <Text style={styles.cue}>{cueText}</Text>
              </View>
            )}
          </View>

          {subPicker && (
            <View style={styles.subPicker}>
              <View style={styles.subCard}>
                <Text style={styles.subHead}>Subtitles</Text>
                <Pressable style={styles.subRow} onPress={() => chooseSubtitle('off')}>
                  <Text style={[styles.subTxt, !activeSub && styles.subOn]}>Off</Text>
                </Pressable>
                {subTracks.map((t: any) => (
                  <Pressable key={t.id} style={styles.subRow} onPress={() => chooseSubtitle('external', t)}>
                    <Text style={[styles.subTxt, activeSub === 'ext:' + t.id && styles.subOn]}>
                      {(t.title || t.language || 'Subtitles') + (t.external ? '' : ' (in the file)')}
                    </Text>
                  </Pressable>
                ))}
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
                <Pressable style={styles.subRow} onPress={() => setSubPicker(false)}>
                  <Text style={styles.subTxt}>Close</Text>
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
  root: { flex: 1, backgroundColor: '#0f0d0a' },
  web: { flex: 1, backgroundColor: '#0f0d0a' },
  playerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  playerBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 40, paddingHorizontal: 12, paddingBottom: 6 },
  backBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2e2820' },
  backTxt: { color: '#efe9df', fontWeight: '600' },
  title: { color: '#efe9df', flex: 1 },
  videoWrap: { flex: 1 },
  video: { flex: 1 },
  // The external-subtitle overlay: above the native controls' resting place,
  // never touchable, readable on any picture.
  cueWrap: { position: 'absolute', left: 16, right: 16, bottom: 84, alignItems: 'center' },
  cue: {
    color: '#fff', fontSize: 16, lineHeight: 22, textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 6, overflow: 'hidden'
  },
  subPicker: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center', padding: 24
  },
  subCard: {
    backgroundColor: '#1a1712', borderColor: '#2e2820', borderWidth: 1,
    borderRadius: 12, padding: 8, alignSelf: 'stretch', maxWidth: 420
  },
  subHead: { color: '#efe9df', fontWeight: '700', fontSize: 16, padding: 10 },
  subRow: { paddingVertical: 12, paddingHorizontal: 10, borderTopWidth: 1, borderTopColor: '#241f18' },
  subTxt: { color: '#efe9df' },
  subOn: { color: '#e2a13d', fontWeight: '700' },
  subNone: { color: '#8f8778', fontSize: 12, padding: 10 }
})
