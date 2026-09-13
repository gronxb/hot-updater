import { finishSpike } from "./spike-assets.mjs";

export function finishLynxE2eBundle(outDir) {
  return finishSpike(outDir, "react", "A", {
    rspeedy: "0.13.5",
    framework: "@lynx-js/react@0.116.5",
    behavior: "normal",
    resourceSet: "sdk3",
    assetPrefix: "hot-updater:///",
  });
}
