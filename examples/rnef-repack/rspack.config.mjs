import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Repack from "@callstack/repack";
import { HotUpdaterPlugin } from "@hot-updater/repack";
import { SentryDebugIdPlugin } from "repack-plugin-sentry";
import "dotenv/config";
import rspack from "@rspack/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Rspack configuration enhanced with Re.Pack defaults for React Native.
 *
 * Learn about Rspack configuration: https://rspack.dev/config/
 * Learn about Re.Pack configuration: https://re-pack.dev/docs/guides/configuration
 */

export default {
  context: __dirname,
  entry: "./index.js",
  resolve: {
    ...Repack.getResolveOptions(),
  },
  module: {
    rules: [
      ...Repack.getJsTransformRules(),
      ...Repack.getAssetTransformRules(),
    ],
  },
  plugins: [
    new Repack.RepackPlugin(),
    new HotUpdaterPlugin(),
    new rspack.EnvironmentPlugin({
      HOT_UPDATER_SUPABASE_URL: JSON.stringify(
        process.env.HOT_UPDATER_SUPABASE_URL,
      ),
    }),
    new SentryDebugIdPlugin(),
  ],
};
