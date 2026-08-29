// JS face of the decoder probe. Android-only; anywhere the native module is
// absent (iOS today, an emulator image without it, a failed link) probe()
// returns null and the worklet keeps its conservative static declaration -
// under-declaring costs the host some engine time, never the viewer a screen.

import { requireNativeModule } from 'expo-modules-core'

export type DecoderInfo = {
  name: string
  mime: string
  hardware: boolean
  profiles: number[]
  maxWidth: number | null
  maxHeight: number | null
}

// What the player chose to hear, read off ExoPlayer's track groups. `tracks`
// counts the file's audio tracks; `selected` says whether ExoPlayer is playing
// any of them. Tracks present and none selected is a film in silence - ExoPlayer
// raises no error for a soundtrack it cannot decode.
export type AudioTrackFact = {
  mime: string | null
  codecs: string | null
  channels: number
  language: string | null
  supported: boolean
  selected: boolean
}

export type AudioSelection = {
  tracks: number
  selected: boolean
  supported: boolean
  formats: AudioTrackFact[]
}

type DecoderProbeNative = {
  probe (): DecoderInfo[]
  audioSelection (player: unknown): Promise<AudioSelection>
}

let native: DecoderProbeNative | null = null
try {
  native = requireNativeModule('DecoderProbe')
} catch {
  native = null
}

export function probe (): DecoderInfo[] | null {
  if (!native) return null
  try {
    return native.probe()
  } catch {
    return null
  }
}

// null wherever the native module is absent or the player is not expo-video's
// on Android; a caller treats null as "cannot tell", never as "silent".
export async function audioSelection (player: unknown): Promise<AudioSelection | null> {
  if (!native || typeof native.audioSelection !== 'function') return null
  try {
    return await native.audioSelection(player)
  } catch {
    return null
  }
}
