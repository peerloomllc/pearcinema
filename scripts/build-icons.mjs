// Every icon this app ships, from one drawing.
//
// There are seven places an icon has to appear - the phone, the Android
// launcher's own two-layer format, the desktop window, the Windows installer,
// the two tray shapes and the Umbrel's app listing - and before this they were
// seven copies of a placeholder circle nobody could regenerate. Now they all
// come out of assets/icon.svg, so changing the mark means changing one file and
// running this.
//
//   node scripts/build-icons.mjs
//
// Needs ImageMagick (`magick`), which is a DEVELOPER tool here, not a build
// dependency: the outputs are committed, so a normal build and a normal
// packaging run never touch this script.
//
// THE ANDROID FOREGROUND IS NOT THE SQUARE ICON. The launcher masks it to
// whatever shape the phone likes - a circle on most - and crops hard. So the
// foreground is the artwork ALONE on transparency, scaled down to sit inside
// that mask, over a flat background colour declared in app.json. Handing it the
// square icon instead is how a pear ends up with its leaf sliced off.

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MASTER = path.join(ROOT, 'assets/icon.svg')
const ART = path.join(ROOT, 'assets/icon-foreground.svg')

// The family's near-black, shared with PearTune's icon and the dashboard's own
// surface colour. app.json's adaptiveIcon.backgroundColor must match it, or the
// launcher draws the pear on one shade and everything else on another.
const BG = '#171410'

// How much of the Android foreground canvas the artwork may occupy. The safe
// zone is nominally the middle 66%, but that is measured across the diagonal of
// a circle, and obeying it literally leaves the pear a speck. 68% of the height,
// centred, keeps the leaf and the stem inside a circular mask - which is the
// thing actually worth protecting - and is checked by eye, not by arithmetic.
const FOREGROUND_FILL = 0.68

function magick (args) {
  try {
    execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('ImageMagick is not installed: `magick` is not on PATH.\n' +
        '  Fedora: sudo dnf install ImageMagick    macOS: brew install imagemagick')
    }
    throw new Error('magick ' + args.join(' ') + '\n' + (e.stderr?.toString() || e.message))
  }
}

const out = (p) => {
  const full = path.join(ROOT, p)
  mkdirSync(path.dirname(full), { recursive: true })
  return full
}

if (!existsSync(MASTER) || !existsSync(ART)) {
  throw new Error('the master drawings are missing: assets/icon.svg and assets/icon-foreground.svg')
}

// --- the square icon, wherever a square icon is wanted ----------------------
// 1024 because that is what App Store Connect demands and everything else is a
// downscale of it. `-alpha remove` because iOS rejects an icon with any
// transparency at all, even a fully opaque alpha channel.
for (const target of ['assets/icon.png', 'desktop/build/icon.png']) {
  magick([MASTER, '-background', BG, '-resize', '1024x1024', '-alpha', 'remove', '-alpha', 'off', out(target)])
  console.log('wrote', target, '1024x1024')
}

// --- the Android launcher's foreground layer --------------------------------
const side = 1024
const fill = Math.round(side * FOREGROUND_FILL)
magick([
  '-background', 'none', ART,
  '-resize', `${side * 2}x${side * 2}`,
  '-trim', '+repage',
  '-resize', `x${fill}`,
  '-gravity', 'center', '-background', 'none', '-extent', `${side}x${side}`,
  out('assets/adaptive-icon.png')
])
console.log('wrote assets/adaptive-icon.png', `${side}x${side} (art at ${Math.round(FOREGROUND_FILL * 100)}% height, transparent)`)

// --- Windows ----------------------------------------------------------------
// Every size in one file, largest first. 16px is a favicon-sized speck where the
// reel is gone and only the pear's outline survives, which is the honest limit
// of this mark and the reason the tray shapes below are drawn simpler.
magick([
  MASTER, '-background', BG, '-alpha', 'remove',
  '-define', 'icon:auto-resize=256,128,64,48,32,16',
  out('desktop/build/icon.ico')
])
console.log('wrote desktop/build/icon.ico (256 down to 16)')

// --- the trays ---------------------------------------------------------------
// A tray icon is 22px. The reel's holes are gone by then and the silver rim
// turns to mud, so the tray wears the SILHOUETTE - pear, leaf, stem, and one
// round hole where the film reel is on the big one. It is the same mark
// squinting, rather than the same drawing shrunk into porridge.
//
// macOS wants a TEMPLATE: black and transparency only, no colour at all, and
// the system recolours it for light and dark menu bars. Getting this wrong
// looks fine on one appearance and invisible on the other.
//
// The hole is not decoration. Without it the tray shape is a plain pear, which
// is what the SISTER app's tray icon is - two PeerLoom apps running at once
// would sit in the menu bar as one shape twice. Where the reel is on the big
// icon, the small one is simply empty.
//
// Its position is measured off the drawing rather than guessed: the artwork is
// taller than it is wide, so a resize fits it to the canvas HEIGHT, and these
// fractions are of that height after trimming. The reel sits on the artwork's
// centre line, so its across-position is simply the middle.
// Re-measured 2026-08-20 for the sibling mark (the pear is PearTune's now, so the
// reel sits lower and larger): the reel's centre is 71.1% down the artwork's own
// bounding box and its silver disc is 20.8% of that height across.
const HOLE_Y = 0.711 // down the artwork, the reel's own centre
const HOLE_R = 0.17 // a little inside the silver rim, so a ring of pear survives

const silhouette = ['-background', 'none', ART, '-resize', '512x512', '-trim', '+repage']

function tray (file, px, { template = false } = {}) {
  const c = Math.round(px * HOLE_Y)
  const r = Math.round(px * HOLE_R)
  magick([
    ...silhouette,
    // A template's shape is its alpha channel and nothing else: black, and the
    // system recolours it for a light or a dark menu bar. Getting this wrong
    // looks right on one appearance and vanishes on the other.
    ...(template ? ['-fill', 'black', '-colorize', '100'] : []),
    '-resize', `${px}x${px}`, '-gravity', 'center', '-background', 'none', '-extent', `${px}x${px}`,
    // Punch the reel out, as a hole rather than a dark disc, so the tray shape
    // reads on any menu bar colour.
    '(', '-size', `${px}x${px}`, 'xc:none', '-fill', 'white', '-draw', `circle ${Math.round(px / 2)},${c} ${Math.round(px / 2)},${c - r}`, ')',
    '-alpha', 'set', '-compose', 'DstOut', '-composite',
    out('desktop/build/' + file)
  ])
  console.log('wrote desktop/build/' + file, `${px}x${px}` + (template ? ' (black + alpha only)' : ''))
}

tray('tray-icon.png', 32)
tray('trayTemplate.png', 22, { template: true })
tray('trayTemplate@2x.png', 44, { template: true })

// --- the Umbrel's app listing ------------------------------------------------
// It takes the drawing itself, so it stays sharp at whatever size the store
// renders it.
magick([MASTER, out('umbrel/icon.svg')])
console.log('wrote umbrel/icon.svg')

console.log('\nall icons rebuilt from assets/icon.svg')
