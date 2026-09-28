// Expo config plugin: adopt the UIScene life cycle on iOS.
//
// An app built with the iOS 27 SDK (Xcode 27) that has no UIApplicationSceneManifest is
// killed at launch on iOS 27 - EXC_BREAKPOINT in
// _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke, before any JS
// runs. That is App Review's "crashed upon launch" on 1.1.4 (15), reproduced on an iOS 27
// iPhone 17 Pro Max Simulator on 2026-09-28. Expo SDK 54's AppDelegate template still makes
// its own window in didFinishLaunching, so the fix has to live here.
//
// What changes in the generated ios/:
// - Info.plist gets a single-scene UIApplicationSceneManifest naming SceneDelegate.
// - AppDelegate.swift stops making the window. SceneDelegate makes it from the window scene
//   and starts React Native in it. It also sets AppDelegate.window, because expo-system-ui
//   and expo-screen-orientation read UIApplication.shared.delegate?.window.
// - Links arrive at the scene, not the app delegate, once scenes are adopted. SceneDelegate
//   hands each one to the AppDelegate's own application(_:open:options:) and
//   application(_:continue:restorationHandler:), so any app-specific link handling there
//   keeps working (PearCal and PearGuard keep theirs in the AppDelegate). A cold-start URL
//   is also passed as launchOptions[.url], which is where RCTLinkingManager's
//   getInitialURL looks.
//
// This file is shared across the suite's iOS apps; keep the copies the same.

const { withInfoPlist, withAppDelegate } = require('expo/config-plugins')

const MARKER = '// with-ios-scene-lifecycle'

const WINDOW_BLOCK = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/

const SCENE_DELEGATE = `
${MARKER}
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)

    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`

function patchAppDelegate (src) {
  if (src.includes(MARKER)) return src
  if (!WINDOW_BLOCK.test(src)) throw new Error('with-ios-scene-lifecycle: window block not found in AppDelegate.swift')
  return src.replace(WINDOW_BLOCK, '    // The window is made by SceneDelegate, below.\n') + SCENE_DELEGATE
}

module.exports = function withIosSceneLifecycle (config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate'
        }]
      }
    }
    return cfg
  })
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') throw new Error('with-ios-scene-lifecycle: expected a Swift AppDelegate')
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents)
    return cfg
  })
}

module.exports.patchAppDelegate = patchAppDelegate
