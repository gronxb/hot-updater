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
