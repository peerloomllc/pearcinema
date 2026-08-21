// THE PLAYER SKINS, in the browser (Tim, 2026-08-21: "is it possible to add the skins to
// the desktop/browser app/player as well?").
//
// The phone has worn these since #58 and the browser has not, which made them a phone
// feature rather than a PearCinema one. They are the same two dressings, drawn the same
// way, and the browser is the easier of the two places to do it: the phone has to poll a
// native video surface for where the picture is, and a `<video>` element tells us.
//
// WHERE THE PICTURE IS, and it is not where the element is. A 2.39:1 film inside a 16:9
// element is letterboxed by `object-fit: contain`, so the strips belong at the PICTURE's
// edges rather than the element's - pinning them to the element would float them in the
// black, which is the one thing that makes a skin look like a bug. The box is computed
// from the video's own intrinsic size, and recomputed when the element resizes, when the
// metadata arrives and on the way in and out of fullscreen.
//
// NOTHING HERE IS INTERACTIVE. `pointer-events: none` throughout, so a click still
// reaches the video underneath and play/pause keeps working through a skin.

import { useState, useEffect, useRef } from 'preact/hooks'
import silhouettes from '../../../assets/mst3k-silhouettes.png'

// The asset is 3200x523 and is drawn at the picture's full width. Change one, change the
// other; the phone carries the same pair of numbers for the same reason.
//
// WHY IT IS 3200 WIDE for a row a few hundred pixels tall: fullscreen. At 1600 the
// upscale to a 4K-ish window frayed every edge, which is what Tim was looking at
// (2026-08-21). It is traced from the drawing rather than resampled from it, so the
// curves are curves at any size.
const ROW_RATIO = 523 / 3200

// One perforation per this many pixels of picture width, and four perforations to a frame
// - 35mm's own arithmetic, and the same numbers the phone uses so the two look alike.
const PITCH_PX = 46
const PERFS_PER_FRAME = 4

function pictureBox (video) {
  if (!video) return null
  const vw = video.videoWidth
  const vh = video.videoHeight
  const w = video.clientWidth
  const h = video.clientHeight
  if (!vw || !vh || !w || !h) return null
  const scale = Math.min(w / vw, h / vh)
  const pw = vw * scale
  const ph = vh * scale
  return { left: (w - pw) / 2, top: (h - ph) / 2, w: pw, h: ph }
}

export default function Skin ({ video, skin = 'off', running = false }) {
  const [box, setBox] = useState(null)
  const raf = useRef(null)

  useEffect(() => {
    if (skin === 'off') { setBox(null); return }
    const el = video?.current
    if (!el) return

    // Measured straight away, and coalesced after that: the first paint must not wait a
    // frame (a skin that arrives late reads as a flicker), while a resize can fire dozens
    // of times a second and only the last one matters.
    const measure = () => setBox(pictureBox(el))
    const soon = () => {
      if (raf.current) clearTimeout(raf.current)
      raf.current = setTimeout(measure, 16)
    }
    measure()
    // The element's size arrives after mount in a real browser, so ask again once the
    // layout has happened rather than only when something changes.
    soon()

    // The element's own size, the film's size, and the browser's window are three
    // different reasons for this to change, and a skin that misses one sits in the black.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null
    ro?.observe(el)
    el.addEventListener('loadedmetadata', measure)
    el.addEventListener('resize', soon)
    window.addEventListener('resize', soon)
    document.addEventListener('fullscreenchange', soon)
    return () => {
      if (raf.current) clearTimeout(raf.current)
      ro?.disconnect()
      el.removeEventListener('loadedmetadata', measure)
      el.removeEventListener('resize', soon)
      window.removeEventListener('resize', soon)
      document.removeEventListener('fullscreenchange', soon)
    }
  }, [skin, video])

  if (skin === 'off' || !box) return null

  if (skin === 'mst3k') {
    const h = box.w * ROW_RATIO
    return (
      <img
        class='skinrow' src={silhouettes} alt='' aria-hidden='true'
        style={{ left: box.left + 'px', top: (box.top + box.h - h) + 'px', width: box.w + 'px', height: h + 'px' }}
      />
    )
  }

  // The 35mm strips: a dark band at each edge of the picture carrying a row of light
  // perforations and a frame line every fourth one, sliding right to left as if the film
  // were being pulled through a projector - and stopping the moment the film does, which
  // is the difference between a projector and a decoration.
  const stripH = Math.max(10, Math.min(30, box.h * 0.07))
  const count = Math.max(6, Math.round(box.w / PITCH_PX))
  const pitch = box.w / count
  const style = {
    '--pitch': pitch + 'px',
    '--hole': Math.max(2, stripH * 0.26) + 'px',
    animationPlayState: running ? 'running' : 'paused'
  }
  const strip = (top) => (
    <div class='fstrip' style={{ left: box.left + 'px', top: top + 'px', width: box.w + 'px', height: stripH + 'px' }}>
      <div class='fstrip-run' style={style} />
    </div>
  )
  return (
    <>
      {strip(box.top)}
      {strip(box.top + box.h - stripH)}
    </>
  )
}
