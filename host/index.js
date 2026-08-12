#!/usr/bin/env node
//
// The PearCinema host daemon.
//
// Starts the library, prints the host key, and - with `--pair` - opens a pairing
// window and draws the QR in the terminal. That last part is the whole of "first
// pair" before there is a dashboard: the operator runs this, points a phone at the
// code, and the phone is in.

const path = require('path')
const z32 = require('z32')
const qrcode = require('qrcode-terminal')

const { PearCinemaHost } = require('./server')
const { codecReport } = require('./codec-report')

const USAGE = `
PearCinema host

  --data <dir>        where identity, grants and settings live (PEARCINEMA_DATA)
  --name <name>       the library's name, as the phone will show it
  --pair              open a pairing window and draw the QR
  --owner             make it an OWNER window (a device paired through it can manage the library)
  --guest <minutes>   make it a GUEST window, access expiring after this many minutes
  --dht-port <port>   pin the DHT's UDP port (only needed behind a manual port-forward)

  --jellyfin <url>    point the library at a Jellyfin or Emby server and save it
  --user <name>       Jellyfin username
  --pass <password>   Jellyfin password
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
    await host.adapter.scan()
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
