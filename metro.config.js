const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// The Bare worklet bundle rides as an asset the shell reads and boots.
config.resolver.assetExts.push('bundle')
// The demo library's posters (assets/demo-library/*.bin) are JPEG data deliberately NOT
// named .jpg. React Native's Android asset packager routes recognised image types into
// res/drawable-*, where they are Android RESOURCES and expo-asset can only hand back a
// resource name - not a path any filesystem call can open, which is exactly how
// PearTune's first demo build failed. Anything it does not recognise goes to res/raw and
// copies out to a real file, which is what the worklet needs in order to read the bytes.
// The films are .mp4, which Metro already treats as an asset.
config.resolver.assetExts.push('bin')
// The demo's own caption file. A source extension would be parsed as JavaScript; an
// asset extension is copied out whole, which is what the worklet reads and hands to the
// player. Written by us - see assets/demo-library/LICENCES.md.
config.resolver.assetExts.push('srt')

module.exports = config
