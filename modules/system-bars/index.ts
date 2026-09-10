// JS face of the system bars.
//
// One call - setHidden(true) while a film is on screen, setHidden(false) when it
// closes - and each platform does as much of it as it can:
//
//   Android, with the native module: the status bar AND the navigation bar go,
//   and a swipe from an edge brings them back for a few seconds.
//   Android, without it (an older build, a stripped emulator image): React
//   Native's StatusBar still hides the clock, so the picture gains the top strip
//   even where the navigation bar stays.
//   iOS: the status bar, through the same React Native module. The home
//   indicator needs a view controller to declare it and this app has no native
//   stack to declare it on, so on iOS the thin line at the bottom stays.
//
// Nothing here ever throws. A bar that will not hide is a smaller picture, never
// a film that fails to play.

import { Platform, StatusBar } from 'react-native'
import { requireNativeModule } from 'expo-modules-core'

type Native = { setHidden (hidden: boolean): Promise<boolean> }

let native: Native | null = null
try {
  native = requireNativeModule('PearSystemBars')
} catch {
  native = null
}

// Whether the navigation bar can be hidden too, which is the half only the
// native module can do.
export const available = () => native !== null

export async function setHidden (hidden: boolean) {
  let done = false
  try { done = !!(await native?.setHidden(hidden)) } catch { done = false }
  // The status bar on its own, for iOS and for any Android build the module did
  // not reach. Harmless after a native call that worked, so it only runs when
  // one did not.
  if (!done) {
    try { StatusBar.setHidden(hidden, Platform.OS === 'ios' ? 'fade' : 'none') } catch {}
  }
}
