const {makeMetroConfig} = require('@rnx-kit/metro-config');
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const config = makeMetroConfig({
  resolver: {
    resolveRequest: MetroSymlinksResolver(),
  },
});

module.exports = config;