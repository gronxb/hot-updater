import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Repack from "@callstack/repack";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appNodeModules = path.join(__dirname, "node_modules");
const resolveOptions = Repack.getResolveOptions();

const runtimeAliases = {
  "@hot-updater/analytics/react-native$": fileURLToPath(
    import.meta.resolve("@hot-updater/analytics/react-native"),
  ),
  "@hot-updater/react-native/runtime-metadata$": fileURLToPath(
    import.meta.resolve("@hot-updater/react-native/runtime-metadata"),
  ),
  react$: path.join(appNodeModules, "react"),
  "react/jsx-dev-runtime$": path.join(
    appNodeModules,
    "react/jsx-dev-runtime.js",
  ),
  "react/jsx-runtime$": path.join(appNodeModules, "react/jsx-runtime.js"),
  "react-native$": path.join(appNodeModules, "react-native"),
};

/**
 * Rspack configuration enhanced with Re.Pack defaults for React Native.
 *
 * Learn about Rspack configuration: https://rspack.dev/config/
 * Learn about Re.Pack configuration: https://re-pack.dev/docs/guides/configuration
 */

export default Repack.defineRspackConfig({
  context: __dirname,
  entry: "./index.js",
  resolve: {
    ...resolveOptions,
    alias: {
      ...(resolveOptions.alias ?? {}),
      ...runtimeAliases,
    },
  },
  module: {
    rules: [
      {
        test: /\.[cm]?[jt]sx?$/,
        type: "javascript/auto",
        use: {
          loader: "@callstack/repack/babel-swc-loader",
          parallel: true,
          options: {},
        },
      },
      ...Repack.getAssetTransformRules(),
    ],
  },
  plugins: [new Repack.RepackPlugin()],
});
