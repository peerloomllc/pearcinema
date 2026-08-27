// WHERE THINGS ACTUALLY ARE, printed - the tool DemoFlow's coordinates come from.
//
// DemoFlow taps three positions no label can reach: the player's CC button and the rows
// of its subtitle picker, which are React Native views drawn above the WebView with no
// accessibilityLabel. Positions rot the moment a layout changes, and a tap that lands 20
// points high reads as a broken feature rather than a bad coordinate - which is exactly
// how an hour went on 2026-08-26, tapping "Off" three times and reading it as captions
// failing to load.
//
// So this walks the same path and dumps the hierarchy with frames at each stop. Run it
// when a take looks wrong, and re-measure rather than guess:
//
//   bash scripts/ios-sim-demo-video.sh --probe
//
// It is not a test in the assert sense - nothing here fails on purpose. It is a camera
// pointed at the accessibility tree.

import XCTest

final class PlaybackProbe: XCTestCase {

  let app = XCUIApplication(bundleIdentifier: "com.pearcinema")

  private func dump (_ what: String) {
    print("=== \(what) ===\n\(app.debugDescription)\n=== END \(what) ===")
  }

  func testProbePlayer () {
    app.launch()
    sleep(18)
    dump("FIRST SCREEN")

    // Straight into the library if the demo is already on; otherwise this run is showing
    // the onboarding tree, which is just as useful to have printed.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.47, dy: 0.58)).tap()
    sleep(5)
    dump("AFTER A TILE TAP")

    let watch = app.buttons["Watch"]
    if watch.waitForExistence(timeout: 10) { watch.tap() } else { print("no Watch button here") }
    sleep(12)

    // The player's own chrome. The WebView dump (scripts/sim-drive.sh) cannot see any of
    // this, which is the whole reason for probing from inside.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
    sleep(2)
    dump("PLAYER CONTROLS")

    app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.14)).tap()
    sleep(3)
    dump("SUBTITLE PICKER")

    print("=== PROBE COMPLETE ===")
  }
}
