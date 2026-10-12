import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finishSpike,
  validateStandardStreamingPageBundles,
} from "./spike-assets.mjs";

export async function finishLynxE2eBundle(outDir) {
  await validateStandardStreamingPageBundles(outDir);
  return finishSpike(outDir, "react", "A", {
    rspeedy: "0.13.5",
    framework: "@lynx-js/react@0.116.5",
    behavior: "normal",
    resourceSet: "sdk3",
    assetPrefix: "hot-updater:///",
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outDir = process.argv[2];
  if (!outDir)
    throw new Error("Usage: node scripts/e2e-assets.mjs <output-directory>");
  await finishLynxE2eBundle(outDir);
}
