#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { bare } from "../../plugins/bare/dist/index.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const example = path.join(root, "examples/v0.85.0");
const markerPath = path.join(example, "src/e2eApp/patchSurface.ts");
const markerPattern = /export const E2E_SCENARIO_MARKER = "[^"]*";/;

async function build(outDir) {
  const plugin = bare({
    enableHermes: true,
    outDir,
    resetCache: false,
  })({ cwd: example });
  await plugin.build({ platform: "android" });
}

const originalMarkerSource = await fs.readFile(markerPath, "utf8");
try {
  await build("dist-benchmark-android");
  const nextMarkerSource = originalMarkerSource.replace(
    markerPattern,
    'export const E2E_SCENARIO_MARKER = "manifest-transfer-benchmark";',
  );
  if (nextMarkerSource === originalMarkerSource) {
    throw new Error("E2E_SCENARIO_MARKER declaration was not found");
  }
  await fs.writeFile(markerPath, nextMarkerSource);
  await build("dist-benchmark-android-next");
} finally {
  await fs.writeFile(markerPath, originalMarkerSource);
}
