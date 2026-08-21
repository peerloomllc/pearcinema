// Build the web interface into ONE self-contained host/ui/dashboard.html, JS and
// CSS inlined.
//
// WHY IT IS BUILT AT ALL, given the host is otherwise plain Node with a small
// dependency set. PearTune's dashboard was a hand-written template literal until a
// syntax error INSIDE THE STRING produced a completely blank control plane that
// every test passed straight through - the page was just a string, so nothing ever
// parsed it. A built app cannot fail that way: this script parses every file, and a
// broken one fails the build rather than the operator's evening.
//
// It is a BUILD-TIME artifact. esbuild, preact and qrcode are devDependencies and
// none of them enter the host image: `npm ci --omit=dev` skips them, and the image
// just serves the committed HTML (host/ui/server.js reads it once at startup). Run
// this whenever anything under host/ui/app/ changes, and COMMIT THE RESULT.
//
// Preact rather than React, deliberately. The whole page is ~45kb of JS instead of
// ~440kb, it escapes by default the same way (which is what closed the donor's
// stored-XSS class of bug), and the host has no other client-side dependency that
// would pull React in anyway.

import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = 'host/ui/dashboard.html'
const TMP_JS = 'host/ui/app/.dashboard.bundle'
const TMP_CSS = 'host/ui/app/.dashboard.css'

await build({
  entryPoints: ['host/ui/app/main.jsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': '"production"' },
  // The theater row is a PNG. Inlined rather than served: this page is one
  // self-contained file by design, and the artwork is 25 KB.
  loader: { '.png': 'dataurl' },
  outfile: TMP_JS,
  legalComments: 'none',
  minify: true
})

// A </script> anywhere in the bundle would close the tag early and truncate the
// page - the exact class of failure a built artifact is supposed to make
// impossible, so it is escaped rather than hoped about.
const js = readFileSync(TMP_JS, 'utf8').replace(/<\/script>/g, '<\\/script>')

const css = existsSync(TMP_CSS) ? readFileSync(TMP_CSS, 'utf8') : ''
if (!css) console.warn('WARNING: no CSS emitted - is styles.css still imported from main.jsx?')

// THE TAB'S ICON IS THE APP'S ICON, read from the one drawing rather than
// written out again here. It used to be a hand-typed blue play triangle left
// over from the donor, which is how a browser tab ends up advertising a
// different app than the one in it. Inlined as a data URI because the dashboard
// is a single self-contained page with nowhere to serve a second file from.
const favicon = 'data:image/svg+xml,' + encodeURIComponent(
  readFileSync('assets/icon.svg', 'utf8')
    .replace(/<!--.*?-->/gs, '')
    .replace(/<title>.*?<\/title>/gs, '')
    .replace(/\s+/g, ' ')
    .trim()
)

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearCinema</title>
  <link rel="icon" href="${favicon}">
  <!-- Height and a first-paint background, and NOTHING on #root. The comment that
       used to sit here said exactly this, and the line under it painted #root
       anyway - an id selector, so no stylesheet below could reach it, and the whole
       page under the header stayed on a dark ground in light mode with dark text on
       it (Tim, 2026-08-19: "light mode isn't rendering properly").

       The colour here is only for the moment between this file parsing and the app
       setting data-theme, so it follows the SYSTEM preference. The stylesheet below
       paints html from the tokens a few bytes later, and the app corrects it to the
       saved preference immediately after that. -->
  <style>html,body,#root{height:100%;margin:0}html{background:#0c0a07}@media (prefers-color-scheme:light){html{background:#faf6ee}}</style>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${js}</script>
</body>
</html>
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(`built ${OUT} (self-contained: ${(js.length / 1024).toFixed(0)}kb js + ${(css.length / 1024).toFixed(1)}kb css)`)
