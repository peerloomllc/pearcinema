#!/usr/bin/env node
//
// The PearCinema host daemon.
//
// Starts the library, serves the web interface, and prints the host key. `--pair`
// still opens a pairing window and draws the QR in the terminal, which is how first
// pair worked before there was a page to draw it on and is still the right answer
// over ssh.

const path = require('path')
const z32 = require('z32')
const qrcode = require('qrcode-terminal')

const { resolveDashboardPassword } = require('@peerloom/host')

const { PearCinemaHost } = require('./server')
const { codecReport } = require('./codec-report')
const { startDashboard } = require('./ui/server')

const USAGE = `
PearCinema host

  --data <dir>        where identity, grants and settings live (PEARCINEMA_DATA)
  --name <name>       the library's name, as the phone will show it
  --pair              open a pairing window and draw the QR
  --owner             make it an OWNER window (a device paired through it can manage the library)
  --guest <minutes>   make it a GUEST window, access expiring after this many minutes
  --dht-port <port>   pin the DHT's UDP port (only needed behind a manual port-forward)

  --http-host <addr>  where the web interface listens (PEARCINEMA_HTTP_HOST, default 127.0.0.1)
  --http-port <port>  its port (PEARCINEMA_HTTP_PORT, default 8742)
  --password <pw>     the web interface's password (PEARCINEMA_PASSWORD).
                      REQUIRED on a non-loopback bind - one is generated and saved if absent.
  --no-http           do not serve the web interface at all

  --jellyfin <url>    point the library at a Jellyfin or Emby server and save it
  --user <name>       Jellyfin username
  --pass <password>   Jellyfin password

  --folder <dir>      point the library at a folder of films and shows and save it
                      (repeatable: --folder /a/Movies --folder /b/TV)
  --rescan            walk the folder again instead of using the cached scan

  --test              check the source works WITHOUT saving it, then exit

  --codec-report      walk the library, print what is actually in it, and exit
`

function arg (name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

function log (msg, data) {
  const at = new Date().toISOString()
  process.stdout.write(data ? `${at} ${msg} ${JSON.stringify(data)}\n` : `${at} ${msg}\n`)
}

async function main () {
  const dataDir = arg('data', process.env.PEARCINEMA_DATA || path.join(process.cwd(), 'host-data'))
  const libraryName = arg('name', process.env.PEARCINEMA_NAME || 'My Library')
  const dhtPort = arg('dht-port', process.env.PEARCINEMA_DHT_PORT || null)

  if (arg('help') || arg('h')) {
    process.stdout.write(USAGE)
    return
  }

  const host = new PearCinemaHost({
    dataDir,
    libraryName,
    dhtPort,
    log
  })

  // Configuring or checking a source happens BEFORE the host listens. There is
  // nothing to serve until the operator has told us where the films are, and a
  // --test run should never announce itself on the DHT.
  // Repeatable, because a real collection is `Movies` on one disk and `TV Shows`
  // on another more often than it is one tidy tree.
  const folders = process.argv.reduce((out, a, i) => {
    if (a === '--folder' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) out.push(process.argv[i + 1])
    return out
  }, [])

  if (folders.length) {
    const cfg = { kind: 'folder', roots: folders }
    if (arg('test')) {
      try {
        log('source:ok', await host.testSource(cfg))
      } catch (e) {
        process.stderr.write(`source failed: ${e.message}\n`)
        process.exitCode = 1
      }
      await host.close()
      return
    }
    log('source:saved', await host.setSource(cfg))
  }

  const jellyfin = arg('jellyfin')
  if (typeof jellyfin === 'string') {
    const cfg = {
      kind: 'jellyfin',
      url: jellyfin,
      username: arg('user') || process.env.PEARCINEMA_JELLYFIN_USER || '',
      password: arg('pass') || process.env.PEARCINEMA_JELLYFIN_PASS || ''
    }

    if (arg('test')) {
      try {
        const res = await host.testSource(cfg)
        log('source:ok', res)
      } catch (e) {
        process.stderr.write(`source failed: ${e.message}\n`)
        process.exitCode = 1
      }
      await host.close()
      return
    }

    const res = await host.setSource(cfg)
    log('source:saved', res)
  }

  if (arg('codec-report')) {
    await host.adapter.scan(arg('rescan') ? { force: true } : {})
    const { text } = await codecReport(host.adapter, {
      onProgress: (n) => { if (n % 500 === 0) log('report:walking', { items: n }) }
    })
    process.stdout.write(text)
    await host.close()
    return
  }

  await host.ready()

  log('host:ready', {
    library: host.libraryName,
    hostKey: z32.encode(host.publicKey),
    libraryId: host.libraryId,
    source: host.adapter.kind,
    sourceError: host.sourceError
  })

  if (host.adapter.kind === 'empty') {
    log('host:no-source', {
      note: 'no source configured yet - the library is empty but the host is reachable and pairable'
    })
  }

  // THE WEB INTERFACE. Everything above this line was reachable only by a phone that
  // had already been paired, which on a packaged install is a chicken-and-egg
  // problem: PearTune pairs by scanning a QR on its dashboard, and until this
  // existed an Umbrel install of PearCinema could be started and never actually
  // reached.
  //
  // Started AFTER host.ready(), so the page never renders a library that has not
  // finished coming up.
  let dashboard = null
  if (!arg('no-http')) {
    const bind = arg('http-host', process.env.PEARCINEMA_HTTP_HOST || '127.0.0.1')
    const httpPort = Number(arg('http-port', process.env.PEARCINEMA_HTTP_PORT || 8742))
    const given = arg('password', process.env.PEARCINEMA_PASSWORD || '')

    // GENERATE-AND-PRINT rather than refuse. A platform install (Umbrel, Start9)
    // mints ${APP_PASSWORD} and takes the 'explicit' path; a bare `docker run` on a
    // NAS has no platform to mint one, and there "refuse to start" would just mean
    // "the install is broken". So a non-loopback bind with no password gets one
    // generated and persisted 0600 to the data dir. requireSafeBind still runs
    // inside startDashboard, so the fail-closed invariant is intact - it is simply
    // never reached now.
    const { password, source } = resolveDashboardPassword({
      password: typeof given === 'string' ? given : '',
      bind,
      dataDir
    })

    const dash = dashboard = await startDashboard({
      host,
      bind,
      port: httpPort,
      password,
      passwordSource: source,
      version: require('../package.json').version,
      log
    })

    log('http:ready', { url: dash.url, locked: !!password })
    if (source === 'generated') {
      process.stdout.write(
        `\n  PearCinema's web page is at ${dash.url}\n` +
        `  Password: ${password}\n` +
        `  (saved in ${path.join(dataDir, 'dashboard-password')} - it will not be printed again)\n\n`
      )
    }
  }

  if (arg('pair')) {
    const link = host.startPairing({
      owner: !!arg('owner'),
      expiresMs: arg('guest') ? Number(arg('guest')) * 60_000 : null
    })
    process.stdout.write('\nScan this with PearCinema:\n\n')
    qrcode.generate(link, { small: true })
    process.stdout.write(`\n${link}\n\n`)
  }

  // The pairing window closes itself after five minutes; the host keeps running.
  const shutdown = async (sig) => {
    log('host:shutdown', { sig })
    if (dashboard) await dashboard.close().catch(() => {})
    await host.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`host failed to start: ${e.stack || e.message}\n`)
    process.exit(1)
  })
}

module.exports = { main }
