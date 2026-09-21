import { existsSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Repack from '@callstack/repack';
import rspack from '@rspack/core';
import { SentryDebugIdPlugin } from 'repack-plugin-sentry';

if (existsSync('.env.hotupdater')) {
  process.loadEnvFile('.env.hotupdater');
}

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
  entry: './index.js',
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
    new rspack.EnvironmentPlugin({
      HOT_UPDATER_SUPABASE_URL: JSON.stringify(
        process.env.HOT_UPDATER_SUPABASE_URL,
      ),
    }),
    new SentryDebugIdPlugin(),
  ],
};
