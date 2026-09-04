#!/usr/bin/env node
'use strict'

// PUSHES metadata/ios/review-notes.md INTO THE App Review Information "Notes" BOX, and
// with no --push, reports whether the box already says what the file says.
//
// WHY IT EXISTS. On 2026-08-31 the NO VPN section was typed straight into App Store
// Connect over the API and never written back to the file, so for three days the note a
// reviewer read and the note in the tree were different documents - and the file is the
// one with a test holding it against the app's own button labels. A script that pushes
// the file makes the file the thing that is true.
//
// The Notes box takes 4000 characters and TRUNCATES a longer write rather than refusing
// it, so the length is checked here as well as in test/review-notes.test.js.
//
// Reads ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID and ASC_PRIVATE_KEY_PATH from
// scripts/.env, the same four scripts/ios-appstore.sh uses.
//
//   node scripts/asc-review-notes.mjs           # compare the server with the file
//   node scripts/asc-review-notes.mjs --push    # write the file to the server

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NOTES_LIMIT = 4000
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// scripts/.env is KEY=value and is not committed. Parsed rather than sourced so this runs
// the same way from any shell - which means expanding $HOME and ~ here, because the file
// is written to be sourced and ASC_PRIVATE_KEY_PATH in it starts with $HOME.
const envFile = path.join(root, 'scripts', '.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || process.env[m[1]]) continue
    const value = m[2].trim().replace(/^["']|["']$/g, '')
    process.env[m[1]] = value
      .replace(/^~(?=\/|$)/, process.env.HOME)
      .replace(/\$\{?HOME\}?/g, process.env.HOME)
  }
}

const KEY_ID = process.env.ASC_KEY_ID
const ISSUER_ID = process.env.ASC_ISSUER_ID
const APP_ID = process.env.ASC_APP_ID
const KEY_PATH = process.env.ASC_PRIVATE_KEY_PATH ||
  path.join(process.env.HOME, '.appstoreconnect', `AuthKey_${KEY_ID}.p8`)

for (const [name, value] of [['ASC_KEY_ID', KEY_ID], ['ASC_ISSUER_ID', ISSUER_ID], ['ASC_APP_ID', APP_ID]]) {
  if (!value) {
    console.error(`Error: ${name} is not set - put it in scripts/.env, beside the ones ios-appstore.sh reads.`)
    process.exit(1)
  }
}
if (!fs.existsSync(KEY_PATH)) {
  console.error(`Error: no App Store Connect key at ${KEY_PATH} (set ASC_PRIVATE_KEY_PATH).`)
  process.exit(1)
}

// The note is everything after the marker line; the header above it is for us. Same split
// as test/review-notes.test.js, so the two cannot disagree about what gets sent.
const notesFile = path.join(root, 'metadata', 'ios', 'review-notes.md')
const body = fs.readFileSync(notesFile, 'utf8').split(/^---$/m).slice(1).join('---').trim()

if (body.length > NOTES_LIMIT) {
  console.error(`Error: the note is ${body.length} characters and the Notes field takes ${NOTES_LIMIT}.`)
  console.error('  Apple truncates rather than refusing, so this would silently lose the tail.')
  process.exit(1)
}
if (/\[VIDEO URL\]|TODO|PLACEHOLDER/.test(body)) {
  console.error('Error: the note still holds a placeholder. Fill it in before pushing.')
  process.exit(1)
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const header = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
const payload = b64({ iss: ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
const signature = crypto
  .sign('sha256', Buffer.from(`${header}.${payload}`), { key: fs.readFileSync(KEY_PATH, 'utf8'), dsaEncoding: 'ieee-p1363' })
  .toString('base64url')
const token = `${header}.${payload}.${signature}`

async function api (method, endpoint, payload) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* Apple returns HTML on some 5xx */ }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join('\n  ') || text.slice(0, 400)
    throw new Error(`${method} ${endpoint} -> ${res.status}\n  ${detail}`)
  }
  return json
}

// THE EDITABLE VERSION, WHICH IS NOT ALWAYS THE NEWEST. A version Apple has finished with
// is frozen; only one in a prepare-for-submission or rejected state takes an edit, so pick
// that one rather than assuming the first row.
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED',
  'WAITING_FOR_REVIEW', 'IN_REVIEW', 'INVALID_BINARY'
])

const versions = await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState`)
const version = versions.data.find((v) => EDITABLE.has(v.attributes.appStoreState))
if (!version) {
  console.error('Error: no App Store version is in an editable state right now.')
  console.error(versions.data.map((v) => `  ${v.attributes.versionString}: ${v.attributes.appStoreState}`).join('\n'))
  process.exit(1)
}
const label = `${version.attributes.versionString} (${version.attributes.appStoreState})`

const detail = await api('GET', `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)
const server = (detail?.data?.attributes?.notes || '').trim()

if (!process.argv.includes('--push')) {
  console.log(`Version ${label}`)
  console.log(`  file:   ${body.length} characters`)
  console.log(`  server: ${server.length} characters`)
  console.log(server === body
    ? '  The Notes box matches the file.'
    : '  DIFFERENT. Run again with --push to make the server say what the file says.')
  process.exit(server === body ? 0 : 1)
}

await api('PATCH', `/v1/appStoreReviewDetails/${detail.data.id}`, {
  data: { type: 'appStoreReviewDetails', id: detail.data.id, attributes: { notes: body } }
})

const after = await api('GET', `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)
const written = (after?.data?.attributes?.notes || '').trim()
if (written !== body) {
  console.error(`Error: the server came back with ${written.length} characters, not the ${body.length} sent.`)
  process.exit(1)
}
console.log(`Pushed ${body.length} characters to the Notes box of version ${label}.`)
