// Build the PHONE UI into ONE self-contained assets/index.html, JS and CSS
// inlined - the shell hands the WebView a document STRING, so a <link> or a
// separate .js would have no origin to load from. Same shape and same reasoning
// as build-dashboard.mjs; the dashboard is the operator's page, this is the
// phone's, and they deliberately share a stack (esbuild + Preact).
//
// Run whenever anything under src/ui/ changes, and COMMIT THE RESULT - the
// bundle rides in the APK as an asset.

import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = 'assets/index.html'
const TMP_JS = 'src/ui/.phone.bundle'
const TMP_CSS = 'src/ui/.phone.css'

// THE VERSION COMES FROM app.json, which is the file a release rewrites. It used to be a
// literal in App.jsx, and PearTune shipped exactly that and caught it on the way to the
// App Store (peartune DONE 2026-07-31): `release.sh` rewrites app.json and never touches
// the UI, so About and every bug report would have said 0.1.0 for ever - and the phone
// stamps its version into a report precisely so the report says which build it came from.
const APP_VERSION = JSON.parse(readFileSync('app.json', 'utf8')).expo.version
if (!APP_VERSION) throw new Error('app.json has no expo.version - the phone would ship with no version at all')

await build({
  entryPoints: ['src/ui/main.jsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // The donor UI's dependencies (@phosphor-icons/react) import react; preact
  // answers, exactly as the donor's own build does it the other way around.
  alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  define: {
    'process.env.NODE_ENV': '"production"',
    __APP_VERSION__: JSON.stringify(APP_VERSION)
  },
  outfile: TMP_JS,
  legalComments: 'none',
  minify: true
})

// A </script> anywhere in the bundle would close the tag early and truncate the
// page - escaped rather than hoped about, same as the dashboard.
const js = readFileSync(TMP_JS, 'utf8').replace(/<\/script>/g, '<\\/script>')

const css = existsSync(TMP_CSS) ? readFileSync(TMP_CSS, 'utf8') : ''
if (!css) console.warn('WARNING: no CSS emitted - is styles.css still imported from main.jsx?')

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>PearCinema</title>
  <!-- Height, and a first-paint background on HTML only. Never on #root: an id
       selector beats every rule in the stylesheet below, so painting it strands the
       whole app on one theme's ground - which is exactly what light mode looked like
       on the dashboard until 2026-08-19. The colour follows the system preference,
       and only until the app sets data-theme a few milliseconds later. -->
  <style>html,body,#root{height:100%;margin:0}html{background:#17140f}@media (prefers-color-scheme:light){html{background:#faf6ee}}</style>
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
