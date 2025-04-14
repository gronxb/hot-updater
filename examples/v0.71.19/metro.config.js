const {makeMetroConfig} = require('@rnx-kit/metro-config');
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");
const { withSentryConfig } = require("@sentry/react-native/metro");

const config = makeMetroConfig({
  resolver: {
    resolveRequest: MetroSymlinksResolver(),
  },
});

module.exports = withSentryConfig(config);