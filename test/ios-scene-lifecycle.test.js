// iOS 27 KILLS AN APP AT LAUNCH IF IT HAS NOT ADOPTED UISCENE, once it is built with the
// iOS 27 SDK. App Review rejected 1.1.4 (15) for exactly that on 2026-09-28. ios/ is
// generated, so plugins/with-ios-scene-lifecycle.js is the fix and this pins it.
// The fixture is the AppDelegate.swift Expo SDK 54's prebuild wrote for the 1.1.4 build.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { patchAppDelegate } = require('../plugins/with-ios-scene-lifecycle')

const root = path.join(__dirname, '..')
const template = fs.readFileSync(path.join(__dirname, 'fixtures', 'expo54-AppDelegate.swift'), 'utf8')

test('app.json runs the scene-lifecycle plugin', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.ok(app.expo.plugins.includes('./plugins/with-ios-scene-lifecycle'))
})

test('the AppDelegate stops making its own window and gains a SceneDelegate', () => {
  const out = patchAppDelegate(template)
  assert.doesNotMatch(out, /UIWindow\(frame: UIScreen\.main\.bounds\)/)
  assert.match(out, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/)
  assert.match(out, /UIWindow\(windowScene: windowScene\)/)
  assert.match(out, /appDelegate\.window = window/)
  assert.match(out, /launchOptions\[\.url\] = url/)
  assert.match(out, /openURLContexts/)
  // Links go through the AppDelegate's own handlers, which is where PearCal and PearGuard
  // route invites.
  assert.match(out, /appDelegate\.application\(UIApplication\.shared, open: context\.url/)
  assert.match(out, /appDelegate\.application\(UIApplication\.shared, continue:/)
  assert.doesNotMatch(out, /_ = RCTLinkingManager/)
})

test('patching twice changes nothing', () => {
  const once = patchAppDelegate(template)
  assert.equal(patchAppDelegate(once), once)
})

test('a template it does not recognise fails the prebuild instead of shipping unpatched', () => {
  assert.throws(() => patchAppDelegate('import Expo\n'), /window block not found/)
})
