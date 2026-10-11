require("./hot-updater-build-config.cjs");
const {makeMetroConfig} = require('@rnx-kit/metro-config');
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

module.exports = makeMetroConfig({
  resolver: {
    resolveRequest: MetroSymlinksResolver(),
  },
});
