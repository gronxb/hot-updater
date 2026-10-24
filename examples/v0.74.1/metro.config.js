const { writeE2eBuildConfig } = require("@examples/e2e-app/build-config");
// makeMetroConfig watches the workspace packages the app depends on, this one
// included.
const { withE2eAppResolveRequest } = require("@examples/e2e-app/metro");
const { makeMetroConfig } = require("@rnx-kit/metro-config");
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

writeE2eBuildConfig(__dirname);

module.exports = makeMetroConfig({
  resolver: {
    resolveRequest: withE2eAppResolveRequest(
      MetroSymlinksResolver(),
      __dirname,
    ),
  },
});
