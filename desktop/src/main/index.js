// PearCinema desktop tray app.
//
// Wraps the PearCinema HOST (the always-on daemon) in a tray / menu-bar app so a
// non-technical user runs it without a terminal. Like the PearTune desktop it is
// ported from, it is a BACKGROUND SERVICE you reach through your browser - there
// is no in-app Chromium window. The tray only manages the host's lifecycle (run
// at login, stay alive, quit); "Open dashboard" opens the dashboard in your real
// browser.
//
// The dashboard binds LOOPBACK (127.0.0.1) with no password (passwordSource
// 'none') - the control plane is only reachable from this machine, so it needs no
// gate. The P2P host (HyperDHT) runs regardless of that bind, so phones pair and
// stream over the internet exactly as on a server install.
//
// One divergence from the PearTune donor: no update checker. PearCinema's host
// has no update-check/update-apply modules yet, so the menu carries a plain
// "Check for updates" that opens the releases page. Port the modules when the
// release cadence earns them.

const { app, Tray, Menu, shell, dialog, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { installService, uninstallService } = require('./service')
const { pointAtBundledFfmpeg } = require('./ffmpeg-env')

// The env vars MUST be set before the host modules load: ffmpeg-bin.js caches
// resolution per process, and the probe/remux paths call it as soon as a scan or
// stream starts.
pointAtBundledFfmpeg(process.resourcesPath)

const { PearCinemaHost } = require('../../vendor/host/server')
const { startDashboard } = require('../../vendor/host/ui/server')

const PORT = 8751
const BIND = '127.0.0.1'
const DASH_URL = `http://${BIND}:${PORT}`
const BUILD = path.join(__dirname, '..', '..', 'build')

const RELEASES_URL = 'https://github.com/peerloomllc/pearcinema/releases/latest'

let host = null
let dashboard = null
let tray = null
// True when a systemd user service already owns the host and this tray process is
// just a client. See main().
let serviceOwned = false

// Is something already serving the dashboard on this port? A systemd user service
// (installed by the .deb postinst or --install-service) starts at boot, and the
// login item then launches this tray app on top of it.
//
// WITHOUT THIS GUARD THAT IS NOT A COSMETIC CLASH: both processes open the SAME
// data dir, which is the library's identity. The second one currently dies with
// a modal error, which is a poor way to learn that your host was already running.
function dashboardAlreadyServing (port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: BIND })
    const done = (v) => { socket.destroy(); resolve(v) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

// CLI actions, handled BEFORE anything asks Electron for a window or a tray.
// `--install-service` is often run over ssh or on a box with no session, and
// app.whenReady() needs a display on Linux - so these must never reach it.
if (process.argv.includes('--install-service')) {
  process.exit(installService())
} else if (process.argv.includes('--uninstall-service')) {
  process.exit(uninstallService())
}

// One host per data dir / port. A second launch just re-opens the dashboard.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openDashboard)
  app.whenReady().then(main)
}

async function main () {
  // Tray-only (menu-bar) app: no dock icon on macOS.
  if (process.platform === 'darwin') app.dock?.hide()

  // A service already serving means this process is a CLIENT, not a host. Adopting
  // it rather than racing it is what keeps two processes off one data dir.
  if (await dashboardAlreadyServing(PORT)) {
    serviceOwned = true
    console.log('pearcinema: a host is already serving on', DASH_URL, '- running as a client.')
    createTray()
    if (!openedAtLogin()) openDashboard()
    return
  }

  try {
    // No library path is passed here: unlike music, a film collection has no OS
    // default folder worth guessing at. The dashboard's first-run wizard is where
    // the operator points the host at a folder or a Jellyfin server, exactly as
    // on the Docker install.
    const dataDir = path.join(app.getPath('userData'), 'data')
    host = new PearCinemaHost({
      dataDir,
      libraryName: 'My Library',
      log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : '')
    })
    await host.ready()

    // Say plainly where ffmpeg came from, or that it is absent. A Jellyfin-only
    // host still works without it, so a miss warns rather than refuses - but the
    // one place a desktop user will look is this log, not a Docker README.
    const bins = require('../../vendor/host/ffmpeg-bin').report()
    console.log('ffmpeg:resolved', JSON.stringify({
      ffmpeg: `${bins.ffmpeg.bin} (${bins.ffmpeg.source})`,
      ffprobe: `${bins.ffprobe.bin} (${bins.ffprobe.source})`
    }))
    if (bins.missing) console.warn('pearcinema:', bins.hint)

    dashboard = await startDashboard({
      host, bind: BIND, port: PORT, password: '', passwordSource: 'none',
      version: app.getVersion()
    })
  } catch (e) {
    dialog.showErrorBox('PearCinema could not start', String(e && e.message || e))
    app.quit()
    return
  }

  createTray()

  // Run at login by default (a host that only runs when you open it is not a host).
  if (app.isPackaged) {
    // --hidden lets us tell a login auto-start from a manual launch (see openedAtLogin).
    try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }) } catch {}
  }

  // On a manual launch, open the dashboard so the user sees something happened; on a
  // login auto-start, stay quiet in the tray.
  if (!openedAtLogin()) openDashboard()
}

// Was this launch the OS auto-starting us at login, rather than the user opening the
// app? macOS reports it directly; on Windows/Linux we pass --hidden in the login-item
// args (and the dev tree, unpackaged, always counts as a manual launch).
function openedAtLogin () {
  try {
    if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin
    return process.argv.includes('--hidden')
  } catch { return false }
}

function openDashboard () {
  shell.openExternal(DASH_URL)
}

function createTray () {
  // macOS menu bar icons are TEMPLATE images: pure black plus an alpha channel, which
  // macOS then renders white on a dark bar, black on a light one, and dims correctly
  // when the menu is open or the display is inactive. The colour icon we ship for
  // Windows and Linux is a fully opaque 32x32, so on a Mac it would render as a dark
  // tile that looks nothing like the native icons beside it.
  //
  // Electron treats a file whose name ends in "Template" as one automatically;
  // setTemplateImage is set anyway so the behaviour does not depend on the filename
  // surviving a future rename.
  const mac = process.platform === 'darwin'
  const img = nativeImage.createFromPath(path.join(BUILD, mac ? 'trayTemplate.png' : 'tray-icon.png'))
  if (mac) img.setTemplateImage(true)
  tray = new Tray(img)
  tray.setToolTip('PearCinema host')
  refreshMenu()
  tray.on('click', openDashboard)
  tray.on('double-click', openDashboard)
}

// Rebuilt, never re-created. A second `new Tray()` leaves the first icon sitting in the
// menu bar forever, so the tray object is made once and only its menu is replaced.
function refreshMenu () {
  if (!tray) return
  // Say which process owns the host, because "Quit PearCinema" means two different
  // things. Owning it, quitting stops the films; as a client of the service, it
  // only closes this tray icon and the library keeps serving. A user who cannot
  // tell those apart will eventually quit expecting one and get the other.
  const ownership = serviceOwned
    ? [{ label: 'Host: running as a background service', enabled: false },
        { label: 'Stop the background service…', click: () => { uninstallService(); app.quit() } },
        { type: 'separator' }]
    : []

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: openDashboard },
    { label: 'Check for updates…', click: () => shell.openExternal(RELEASES_URL) },
    { type: 'separator' },
    ...ownership,
    { label: `PearCinema ${app.getVersion()}`, enabled: false },
    { label: serviceOwned ? 'Quit (leaves the host running)' : 'Quit PearCinema', click: () => app.quit() }
  ]))
}

// No windows, ever: never quit just because a window closed (this is a background
// service). Only an explicit Quit / app.quit() ends it - handled by before-quit.
app.on('window-all-closed', () => { /* stay alive in the tray */ })

app.on('before-quit', async (e) => {
  if (!host && !dashboard) return // already torn down; let the quit proceed
  e.preventDefault()
  const d = dashboard, h = host
  host = dashboard = null
  try { await d?.close() } catch {}
  try { await h?.close() } catch {}
  app.quit()
})
