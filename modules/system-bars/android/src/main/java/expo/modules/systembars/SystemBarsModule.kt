package expo.modules.systembars

import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// A FILM SHOULD HAVE THE WHOLE SCREEN.
//
// The player is a full-screen overlay drawn by the shell, so while one is up the
// status bar's clock and the navigation bar sit on top of the picture. React
// Native's own StatusBar module hides the status bar and nothing else - there is
// no core API for the navigation bar, and expo-navigation-bar's visibility calls
// are no-ops now that Android draws every app edge to edge. So this module hides
// both at once, the way the platform asks for it: one insets controller, one
// systemBars() type.
//
// THE BARS ARE HIDDEN, NOT LOCKED AWAY. BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE is
// what every video app uses: a swipe from an edge brings the bars back over the
// picture for a few seconds and then they leave again. Anything stricter is a
// phone whose owner cannot reach Home without stopping the film.
class SystemBarsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PearSystemBars")

    // true while a film is on screen, false when it closes. Returns whether it
    // could be done at all - no activity means the app is on its way out, and
    // the caller treats that as nothing to do rather than as an error.
    AsyncFunction("setHidden") { hidden: Boolean ->
      val window = appContext.currentActivity?.window ?: return@AsyncFunction false
      WindowInsetsControllerCompat(window, window.decorView).run {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hidden) hide(WindowInsetsCompat.Type.systemBars())
        else show(WindowInsetsCompat.Type.systemBars())
      }
      true
    }.runOnQueue(Queues.MAIN)
  }
}
