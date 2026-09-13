import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LYNX_E2E_BUILTIN_BUNDLE_ID } from "../../../e2e/lynx/embedded-bundle.ts";
import { lynx } from "../../../packages/lynx/dist/build.mjs";

const [framework, platform, fixture, runtimeId, ...extra] =
  process.argv.slice(2);
if (
  !["react", "vue", "octane"].includes(framework) ||
  !["ios", "android"].includes(platform) ||
  !/^A-sdk\d+-managed$/.test(fixture) ||
  !/-ota-v[12]$/.test(runtimeId ?? "") ||
  (fixture?.includes("sdk3") && !runtimeId?.endsWith("-ota-v2")) ||
  extra.length
) {
  throw new Error(
    "Usage: node scripts/ota-embedded.mjs <react|vue|octane> <ios|android> <A-sdkN-managed> <native-ota-runtime-id>; SDK3 requires ota-v2",
  );
}
const example = fileURLToPath(new URL("../", import.meta.url));
const root = path.join(example, ".hot-updater/ota");
const source = await fs.realpath(
  path.join(example, ".hot-updater/g1", framework, fixture),
);
const cliRequire = createRequire(
  new URL("../../../packages/hot-updater/package.json", import.meta.url),
);
const jiti = cliRequire("jiti").createJiti(import.meta.url);
const { getBundleZipTargets } = await jiti.import(
  "../../../packages/hot-updater/src/utils/getBundleZipTargets.ts",
);
const { createBundleManifest, writeBundleManifestFile } = await jiti.import(
  "../../../packages/hot-updater/src/utils/bundleManifest.ts",
);
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const collect = async (directory) => {
  const files = {};
  for (const name of (
    await fs.readdir(directory, { recursive: true })
  ).sort()) {
    const absolute = path.join(directory, name);
    if ((await fs.lstat(absolute)).isFile())
      files[name.split(path.sep).join("/")] = await fs.readFile(absolute);
  }
  return files;
};
const sourceFiles = await collect(source);
const validation = await lynx({
  outDir: ".hot-updater/ota/embedded-build",
  build: async ({ outDir }) => {
    await fs.cp(source, outDir, { recursive: true });
    return { entry: "main.lynx.bundle", runtimeId };
  },
})({ cwd: example }).build({ platform });
const validatedFiles = await collect(validation.buildPath);
const label = `${framework}-${platform}-${fixture}`;
const outputPath = path.join(
  root,
  "embedded",
  `${label}-${crypto.randomUUID()}`,
);
await fs.cp(validation.buildPath, outputPath, { recursive: true });

// Native embedding owns the fixed E2E identity; the validated OTA build stays immutable.
const metadata = JSON.parse(validatedFiles["hot-updater-lynx.json"].toString());
assert.equal(metadata.bundleId, validation.bundleId);
metadata.bundleId = LYNX_E2E_BUILTIN_BUNDLE_ID;
await fs.writeFile(
  path.join(outputPath, "hot-updater-lynx.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
const outputFilesBeforeManifest = await collect(outputPath);
const targets = await getBundleZipTargets(
  outputPath,
  Object.keys(outputFilesBeforeManifest).map((name) => ({
    path: path.join(outputPath, name),
    name,
    downloadCompression: null,
  })),
);
let manifest;
try {
  manifest = await createBundleManifest({
    bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
    patchAssetPath: metadata.entry,
    targetFiles: targets.artifacts,
  });
} finally {
  await fs.rm(targets.path, { recursive: true, force: true });
}
await writeBundleManifestFile({ buildPath: outputPath, manifest });
const files = await collect(outputPath);
assert.deepEqual(
  Object.keys(files).sort(),
  [
    ...Object.keys(sourceFiles),
    "hot-updater-lynx.json",
    "manifest.json",
  ].sort(),
);
for (const [name, bytes] of Object.entries(sourceFiles))
  assert.deepEqual(files[name], bytes, name);
for (const [name, asset] of Object.entries(manifest.assets))
  assert.equal(asset.fileHash, sha256(files[name]), name);
assert.deepEqual(await collect(source), sourceFiles);
assert.deepEqual(await collect(validation.buildPath), validatedFiles);
const receipt = {
  verifiedAt: new Date().toISOString(),
  framework,
  platform,
  fixture,
  runtimeId,
  source,
  validationBundleId: validation.bundleId,
  validatedBuildPath: validation.buildPath,
  embeddedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
  minimumBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
  outputPath,
  manifestFileHash: sha256(files["manifest.json"]),
  catalogMutation: false,
  files: Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      { byteSize: bytes.length, sha256: sha256(bytes) },
    ]),
  ),
};
const receiptPath = path.join(root, "receipts", `${label}-embedded.json`);
await fs.mkdir(path.dirname(receiptPath), { recursive: true });
await fs.writeFile(
  `${outputPath}.json`,
  `${JSON.stringify(receipt, null, 2)}\n`,
);
await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      receiptPath,
      outputPath,
      manifestFileHash: receipt.manifestFileHash,
      embeddedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
    },
    null,
    2,
  ),
);
