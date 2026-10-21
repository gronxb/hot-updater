const path = require("node:path");

/**
 * A Jest resolver for a target app (`resolver` in its jest.config.js, with
 * `rootDir` the app): this package's bare imports resolve from the app, so
 * the app's mocks and copies of React, React Native and the SDK apply, as in
 * the app's bundler.
 */
module.exports = (request, options) => {
  const fromPackage = options.basedir.startsWith(__dirname + path.sep);
  const bare = !request.startsWith(".") && !path.isAbsolute(request);
  return options.defaultResolver(
    request,
    fromPackage && bare ? { ...options, basedir: options.rootDir } : options,
  );
};
