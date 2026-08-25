// The Play Store feature graphic: metadata/android/feature-graphic.png, 1024x500.
//
// Play requires one for a listing and the repo had icons only - the same gap PearTune
// had, and it had to build one too (peartune DONE 2026-07-31).
//
// NO FILM ARTWORK IN IT, and that matters more here than it did for music. A poster or a
// frame from a film is somebody else's work, and a store banner carrying one is a rights
// question attached to the listing for as long as it is up. So this is built from things
// that are entirely ours: the app's own mark, its own Manrope (the very bytes the phone
// ships, read out of src/ui/fonts.js) and its own colour tokens, read out of
// src/ui/styles.css rather than typed in again.
//
// RENDERED IN A BROWSER rather than composed with ImageMagick, because Manrope is not a
// system font here and text drawn in the wrong face is exactly the kind of thing that
// looks fine at a glance and wrong beside the app.
//
//   node scripts/build-feature-graphic.mjs
//
// Run it again after any change to the mark or the palette; the output is deterministic,
// so a rebuild that changes nothing produces the same bytes.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const OUT_DIR = 'metadata/android'
const OUT = join(OUT_DIR, 'feature-graphic.png')
const W = 1024
const H = 500

// THE FONT THE PHONE ACTUALLY SHIPS. fonts.js is one exported CSS string with three
// @font-face rules and the woff2 inlined as data URIs, so pulling the string out gives a
// browser everything it needs with nothing to install.
const fontsSrc = readFileSync('src/ui/fonts.js', 'utf8')
const FONT_CSS = fontsSrc.slice(fontsSrc.indexOf('"') + 1, fontsSrc.lastIndexOf('"'))
  .replace(/\\"/g, '"')
if (!FONT_CSS.includes('@font-face')) throw new Error('could not read the font CSS out of src/ui/fonts.js')

// THE PALETTE THE APP ACTUALLY USES, read rather than retyped, so a theme change that
// never reaches this file cannot leave the banner quietly off-brand.
const css = readFileSync('src/ui/styles.css', 'utf8')
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css)
  if (!m) throw new Error(`no --${name} in src/ui/styles.css`)
  return m[1]
}
const PRIMARY = token('color-primary')          // the warm gold the app is built around
const BASE = token('color-surface-base')        // near-black, warm rather than grey
const CARD = token('color-surface-card')
const TEXT = token('color-text-primary')
const MUTED = token('color-text-secondary')

// THE MARK ON ITS OWN, not the app icon. `assets/icon.png` is a square with its own
// background baked in, and on a gradient it reads as a pasted rectangle rather than a
// logo - visible immediately in the first render. `assets/adaptive-icon.png` is the same
// drawing with a transparent surround (it is the Android adaptive foreground), so it sits
// on the banner with no box around it. Its transparent margin is the Android mask's safe
// zone and is trimmed here, because that padding is for a circle this graphic does not
// have.
const markTmp = join(tmpdir(), 'pearcinema-mark.png')
execFileSync('magick', ['assets/adaptive-icon.png', '-trim', '+repage', markTmp])
const icon = readFileSync(markTmp).toString('base64')

// THE LOCKUP IS CENTRED, both ways, because Play's own guidance is that anything near an
// edge may be cropped - the graphic is shown at more than one aspect ratio and in more
// than one placement. The first draft ran the mark and words from the left margin and
// left 300px of empty space on the right, which is fine at 1024x500 and off-centre
// everywhere else.
const html = `<!doctype html><meta charset="utf-8">
<style>
${FONT_CSS}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
body {
  background:
    radial-gradient(120% 140% at 12% 18%, ${CARD} 0%, ${BASE} 62%),
    ${BASE};
  font-family: 'Manrope', system-ui, sans-serif;
  color: ${TEXT};
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 44px;
  padding: 0 64px;
}
/* A soft warm wash from the left, so the flat background does not read as a black box
   in a scrolling list of colourful banners. */
body::before {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(58% 110% at 6% 50%, ${PRIMARY}22 0%, transparent 70%);
}
/* HEIGHT ONLY, and the width follows. The trimmed mark is 435x694 - a pear is taller
   than it is wide - and forcing it into a square box stretched it visibly wider, which
   the first render with the trimmed art showed at once. */
.mark { flex: none; position: relative; display: flex; }
.mark img { height: 196px; width: auto; display: block; }
.words { position: relative; }
h1 {
  font-weight: 500;
  font-size: 78px;
  letter-spacing: -0.028em;
  line-height: 1;
}
h1 .pear { color: ${TEXT}; }
h1 .cinema { color: ${PRIMARY}; }
p {
  margin-top: 18px;
  font-weight: 300;
  font-size: 29px;
  line-height: 1.32;
  color: ${MUTED};
  max-width: 560px;
  letter-spacing: -0.006em;
}
</style>
<div class="mark"><img src="data:image/png;base64,${icon}" alt=""></div>
<div class="words">
  <h1><span class="pear">Pear</span><span class="cinema">Cinema</span></h1>
  <p>Your films and shows, playable anywhere.<br>No port forwarding. No cloud. No account.</p>
</div>`

const dir = join(tmpdir(), 'pearcinema-feature-graphic')
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const page = join(dir, 'graphic.html')
writeFileSync(page, html)

// The bundled Chrome for Testing, which is what the suite's browser tooling already uses.
// Named explicitly rather than found on PATH: a system chromium may render a different
// font stack, and this file's whole point is that the type is the app's.
const CHROME = process.env.CHROME || [
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-152.0.7977.42/chrome-linux64/chrome`
].find((p) => existsSync(p))
if (!CHROME) throw new Error('no Chrome for Testing found - set CHROME=/path/to/chrome')

mkdirSync(OUT_DIR, { recursive: true })
execFileSync(CHROME, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${W},${H}`,
  `--screenshot=${OUT}`,
  'file://' + page
], { stdio: 'pipe' })

// PLAY REJECTS RGBA, and screencap-style pipelines are where alpha creeps in - PearTune
// lost a cycle to exactly that on both stores in one day. Flatten onto the background and
// state what came out, rather than trusting that a screenshot is opaque.
execFileSync('magick', [OUT, '-background', BASE, '-alpha', 'remove', '-alpha', 'off', OUT])

const id = execFileSync('magick', ['identify', '-format', '%wx%h %[channels] %[bit-depth]-bit', OUT]).toString()
rmSync(dir, { recursive: true, force: true })
rmSync(markTmp, { force: true })

console.log(`wrote ${OUT}`)
console.log(`  ${id}`)
if (!id.startsWith(`${W}x${H} `)) throw new Error(`wrong size: ${id}`)
if (id.includes('a)') || id.includes('rgba')) throw new Error(`alpha survived, and Play refuses it: ${id}`)
