// NO DEMO LIBRARY HERE, ON PURPOSE (proposal 2026-08-26-app-review-demo).
//
// This is the file Metro resolves `./demo-assets` to on every platform except iOS -
// which today means Android. It exports nothing, so no film is referenced from an
// Android bundle and none is packaged into one.
//
// WHY. Play caps the compressed download of an app bundle's base module at 200 MB, and
// 164 MB of film on top of the app exceeds it. Apple's 200 MB is only where a cellular
// install asks first, and Apple's Guideline 2.1 is the reason the demo exists at all.
// The two rejected alternatives were a Play asset pack (real build machinery to set up
// and keep working) and a smaller Android library (two versions of the same thing to
// keep straight).
//
// IT SPLITS THE ONBOARDING TOO, not just the build: the "look around without a server"
// card can only appear where the films are, so on Android the intro keeps offering the
// two real answers exactly as it did before the demo existed. The UI asks the shell
// what it has (shell.demoAvailable) rather than testing the platform, so this file is
// the single place the answer comes from.
//
// See shell/demo-assets.ios.ts for the other half, and test/demo-build-rule.test.js,
// which fails if a film ever appears in this one.

export const DEMO_MANIFEST: any = null
export const DEMO_FILES: Record<string, any> = {}
export const DEMO_POSTERS: Record<string, any> = {}
