// The root layout, and it exists to REMOVE something.
//
// Without a _layout file expo-router supplies its own (DefaultNavigator in
// expo-router/build/views/Navigator.js), and on iOS that one wraps the whole app
// in a SafeAreaView. On Android, where the app is drawn edge to edge, it does not -
// so the two platforms disagreed about who owns the safe area, and on iOS the
// player's full-screen overlay was boxed in by a band of shell background at the
// top and another at the bottom while the film played inside them.
//
// The shell already handles the insets itself and has to: the WebView cannot read
// env(safe-area-inset-*) on Android, so app/index.tsx keeps the page clear of the
// status bar and the cutout with its own margins and hands the bottom inset to the
// page. This is the same Slot the default layout renders, without the wrapper, so
// iOS and Android now agree and a film fills the screen on both.

import { Slot } from 'expo-router'

export default function RootLayout () {
  return <Slot />
}
