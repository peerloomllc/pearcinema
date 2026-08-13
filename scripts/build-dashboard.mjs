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

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PearCinema</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230e0f13'/%3E%3Cpath d='M12 9.5v13l10-6.5z' fill='%236ea8fe'/%3E%3C/svg%3E">
  <!-- Height and a fallback background only. Do NOT set colours here: #root has id
       specificity and would override the theme tokens, which is exactly how a
       themed page ends up stranded on one theme's background. -->
  <style>html,body,#root{height:100%;margin:0;background:#0e0f13}</style>
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
