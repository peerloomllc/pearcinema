const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// The Bare worklet bundle rides as an asset the shell reads and boots.
config.resolver.assetExts.push('bundle')

module.exports = config
