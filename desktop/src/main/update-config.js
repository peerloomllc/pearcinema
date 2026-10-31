// Settings for @peerloom/host's update checker (desktop/src/main/index.js).
// Its own file so test/update-config.test.js can load it without Electron.

// The names electron-builder gives the desktop files (desktop/package.json). The
// checker uses them to tell whether a release rebuilt this platform: one that did
// not is not offered here. The Intel dmg has no arch in its name.
module.exports = {
  name: 'PearCinema',
  slug: 'pearcinema',
  repo: 'peerloomllc/pearcinema',
  envPrefix: 'PEARCINEMA',
  assets: {
    win32: /^PearCinema-Setup-.*\.exe$/i,
    darwinArm64: /^PearCinema-.*-arm64\.dmg$/i,
    darwinX64: /^PearCinema-[\d.]+\.dmg$/i,
    appImage: /^PearCinema-.*\.AppImage$/i,
    deb: /^pearcinema-desktop_.*_amd64\.deb$/i
  },
  mac: { appBundle: 'PearCinema.app', teamId: 'G79ALD29NA', daemonPlist: null, hostArgv: null },
  linux: { unit: null, debHelper: null },
  windows: { service: null, installerArgs: ['/S'] }
}
