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

  const host = new PearCinemaHost({
    dataDir,
    libraryName,
    dhtPort,
    log
  })

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
