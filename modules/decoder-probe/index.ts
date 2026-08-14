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

type DecoderProbeNative = { probe (): DecoderInfo[] }

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
