const {makeMetroConfig} = require('@rnx-kit/metro-config');

module.exports = makeMetroConfig({
  resolver: {
    unstable_enableSymlinks: true,
  },
});
