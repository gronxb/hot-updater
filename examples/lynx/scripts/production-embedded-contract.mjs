import fs from "node:fs/promises";
import path from "node:path";

export const productionEmbeddedForbiddenMarkers = [
  "http://localhost:3007",
  "http://127.0.0.1:",
  "/matrix-runtime-snapshot",
  "HOT_UPDATER_",
  "E2E_",
  "navigation-boundary",
  "Verify navigation boundary",
  "Capture runtime events",
  "targeted-qa-detox",
  "detail-diagnostic",
];

const pageRequirements = {
  "detail.lynx.bundle": [
    "sparkling-navigation",
    "router.close",
    "Close detail page",
  ],
  "main.lynx.bundle": [
    "sparkling-navigation",
    "router.open",
    "detail.lynx.bundle",
    "Open detail page",
  ],
};

export const productionSdkCalls = {
  "detail.lynx.bundle": [".notifyAppReady()"],
  "main.lynx.bundle": [
    ".getLaunchConfiguration()",
    ".init({baseURL:",
    ".checkForUpdate({updateStrategy:",
    ".updateBundle()",
    ".notifyAppReady()",
    ".reload()",
  ],
};

export async function validateProductionEmbeddedBundles(root) {
  const files = (await fs.readdir(root, { recursive: true }))
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.endsWith(".lynx.bundle"))
    .sort();
  const expectedPages = Object.keys(pageRequirements).sort();
  if (expectedPages.some((page) => !files.includes(page))) {
    throw new Error("Production embedded output is missing a page bundle");
  }
  const checks = {};
  for (const file of files) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    const present = productionEmbeddedForbiddenMarkers.filter((marker) =>
      text.includes(marker),
    );
    if (present.length) {
      throw new Error(
        `Production embedded ${file} contains test diagnostics: ${present.join(", ")}`,
      );
    }
    const required = pageRequirements[file] ?? [];
    const missing = required.filter((marker) => !text.includes(marker));
    if (missing.length) {
      throw new Error(
        `Production embedded ${file} is missing public navigation: ${missing.join(", ")}`,
      );
    }
    const sdkCalls = productionSdkCalls[file] ?? [];
    const missingSdkCalls = sdkCalls.filter((call) => !text.includes(call));
    if (missingSdkCalls.length) {
      throw new Error(
        `Production embedded ${file} is missing Hot Updater SDK calls: ${missingSdkCalls.join(", ")}`,
      );
    }
    checks[file] = {
      forbiddenPresent: present,
      requiredPresent: required,
      sdkCallsPresent: sdkCalls,
    };
  }
  return {
    schemaVersion: "lynx-production-embedded-contract-v1",
    files,
    forbiddenMarkers: productionEmbeddedForbiddenMarkers,
    checks,
  };
}
