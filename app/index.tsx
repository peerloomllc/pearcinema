// The PearCinema shell: boots the Bare worklet, bridges it to the WebView UI, and
// otherwise stays out of the way.
//
// PearTune's shape (its shell is the donor and carries the scars): the worklet is
// the P2P backend, the WebView is the whole interface, and this file is the only
// place the two meet. Requests ride { id, method, args } both hops - WebView to
// shell over postMessage, shell to worklet over BareKit IPC - and replies come
// back on the same ids. Events push the other way as { event, data }.

import { useEffect, useRef, useState } from 'react'
import { BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { VideoView, useVideoPlayer } from 'expo-video'
import { Worklet } from 'react-native-bare-kit'
import * as FileSystem from 'expo-file-system/legacy'
import { Asset } from 'expo-asset'
import * as SplashScreen from 'expo-splash-screen'
import b4a from 'b4a'

const bundle = require('../assets/bare-universal.bundle')

SplashScreen.preventAutoHideAsync().catch(() => {})

export default function App () {
  const webref = useRef<WebView>(null)
  const ipcRef = useRef<any>(null)
  const workletRef = useRef<Worklet | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const pendingLink = useRef<string | null>(null)
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
  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = 5 })

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
    const forward = (url: string | null) => {
      if (!url || !url.includes('/pair')) return
      pendingLink.current = url
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
    const tick = setInterval(() => {
      const p = playingRef.current
      if (!p) return
      const payload = JSON.stringify({ itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:tick', ${payload})`)
    }, 15000)
    return () => { sub.remove(); clearInterval(tick) }
  }, [playing])

  const stopPlayback = () => {
    const p = playingRef.current
    if (p) {
      const payload = JSON.stringify({ itemId: p.itemId, positionMs: Math.round(lastPos.current * 1000) })
      feedWebView(`window.__pearEvent && window.__pearEvent('player:closed', ${payload})`)
    }
    try { player.pause() } catch {}
    setPlaying(null)
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
      feedWebView(`window.__pearResponse && window.__pearResponse(${JSON.stringify(msg.id)}, ${JSON.stringify({ result: pendingLink.current, error: null })})`)
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
          </View>
          <VideoView
            style={styles.video}
            player={player}
            nativeControls
            allowsFullscreen
            contentFit='contain'
          />
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
  video: { flex: 1 }
})
