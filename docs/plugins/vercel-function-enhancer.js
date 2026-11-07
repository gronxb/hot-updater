// Loaded by Node during `waku build`, outside the Vite bundle, so it stays
// plain JavaScript.
import { rmSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   distDir: string;
 *   rscBase: string;
 *   DIST_PUBLIC: string;
 *   serverless: boolean;
 * }} VercelBuildOptions
 * @typedef {(utils: unknown, options: VercelBuildOptions) => Promise<void>} Build
 */

/**
 * Runs after Waku's Vercel build enhancer and removes the static site it
 * copied into the function. The function only needs `dist/server`.
 *
 * @param {Build} build
 * @returns {Promise<Build>}
 */
export default async function vercelFunctionEnhancer(build) {
  return async (utils, options) => {
    await build(utils, options);

    if (!options.serverless) {
      return;
    }

    rmSync(
      path.resolve(
        ".vercel",
        "output",
        "functions",
        `${options.rscBase}.func`,
        options.distDir,
        options.DIST_PUBLIC,
      ),
      { recursive: true, force: true },
    );
  };
}
