// WebView -> shell IPC. Same shape as every app in the suite: post { id, method,
// args }, get a __pearResponse back, listen for __pearEvent pushes. Adapted from
// PearTune's bridge minus its screenshot-scene wrapper, which arrives with the
// store-listing work and not before.

const pending = new Map()
let nextId = 1
const listeners = new Map()

window.__pearResponse = (id, payload) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  if (payload.error) p.reject(new Error(payload.error))
  else p.resolve(payload.result)
}

window.__pearEvent = (name, data) => {
  for (const fn of listeners.get(name) || []) fn(data)
}

export function call (method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))
  })
}

export function on (name, fn) {
  if (!listeners.has(name)) listeners.set(name, [])
  listeners.get(name).push(fn)
  return () => {
    const arr = listeners.get(name) || []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
}
