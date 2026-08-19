// JS face of the cast remote. Android-only; anywhere the native module is absent
// (iOS today, an emulator image without it, a failed link) every call is a no-op and
// the app behaves exactly as it did before - the bar inside the app is still there.
//
// This is NOT the phone's own player. expo-video publishes its own now-playing
// information for that. This is the other case: a film on a television with this
// phone driving it, and a lock screen that can pause the room without unlocking.

import { requireNativeModule } from 'expo-modules-core'

export type CastRemoteInfo = {
  title: string
  subtitle: string
  artUrl?: string | null
  paused: boolean
  canSkip: boolean
  positionMs: number
  durationMs: number
}

export type CastRemoteAction = { action: 'play' | 'pause' | 'stop' | 'forward' | 'back' | 'seek', positionMs?: number }

type Native = {
  show (info: CastRemoteInfo): Promise<void>
  hide (): Promise<void>
  addListener (event: 'onAction', cb: (e: CastRemoteAction) => void): { remove (): void }
}

let native: Native | null = null
try {
  native = requireNativeModule('CastRemote')
} catch {
  native = null
}

export const available = () => native !== null

export async function show (info: CastRemoteInfo) {
  try { await native?.show(info) } catch { /* a remote that cannot be drawn is not an error worth showing */ }
}

export async function hide () {
  try { await native?.hide() } catch {}
}

export function onAction (cb: (e: CastRemoteAction) => void) {
  if (!native) return () => {}
  const sub = native.addListener('onAction', cb)
  return () => { try { sub.remove() } catch {} }
}
