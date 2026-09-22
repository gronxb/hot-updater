#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";

import {
  applyBsdiffPatch,
  createBsdiffPatch,
} from "../../packages/bsdiff/dist/internal/bsdiff.js";
import "../../packages/bsdiff/dist/node.js";
import JSZip from "../../packages/cli-tools/node_modules/jszip/lib/index.js";

const root = path.resolve(import.meta.dirname, "../..");
const example = path.join(root, "examples/v0.85.0");
const packagingEvidence = JSON.parse(
  await fs.readFile(
    path.join(import.meta.dirname, "builtin-packaging.json"),
    "utf8",
  ),
);
const rounds = 7;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sum = (values) => values.reduce((total, value) => total + value, 0);

async function readTarget(rootDir, platform) {
  const bundleName = `index.${platform}.bundle`;
  const files = new Map();
  files.set(
    bundleName,
    await fs.readFile(path.join(rootDir, `${bundleName}.hbc`)),
  );

  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.name.endsWith(".png")) {
        files.set(
          path.relative(rootDir, absolute).replaceAll(path.sep, "/"),
          await fs.readFile(absolute),
        );
      }
    }
  }
  await visit(rootDir);
  return files;
}

function createManifest(name, files) {
  return Buffer.from(
    `${JSON.stringify({
      bundleId: `benchmark-${name}`,
      assets: Object.fromEntries(
        [...files].map(([assetPath, bytes]) => [
          assetPath,
          { fileHash: sha256(bytes) },
        ]),
      ),
    })}\n`,
  );
}

async function createArchive(manifest, files) {
  const zip = new JSZip();
  zip.file("manifest.json", manifest);
  for (const [assetPath, bytes] of files) zip.file(assetPath, bytes);
  return zip.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
    type: "nodebuffer",
  });
}

function originalPayload(assetPath, bytes) {
  if (/^index\.[^/]+\.bundle$/.test(assetPath)) {
    return {
      bytes: brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }),
      encoding: "br",
    };
  }
  return { bytes, encoding: "identity" };
}

async function createScenario({ base, files, name, patchPath, reusable }) {
  const manifest = createManifest(name, files);
  const archive = await createArchive(manifest, files);
  const payloads = new Map();

  for (const [assetPath, bytes] of files) {
    if (reusable.has(assetPath)) continue;
    if (patchPath === assetPath) {
      payloads.set(assetPath, {
        bytes: Buffer.from(await createBsdiffPatch(base.get(assetPath), bytes)),
        encoding: "bsdiff",
      });
    } else {
      payloads.set(assetPath, originalPayload(assetPath, bytes));
    }
  }

  return { archive, base, files, manifest, name, payloads, reusable };
}

async function directorySize(dir) {
  let bytes = 0;
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else bytes += (await fs.stat(absolute)).size;
    }
  }
  await visit(dir);
  return bytes;
}

async function writeAsset(rootDir, assetPath, bytes) {
  const destination = path.join(rootDir, assetPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}

async function verifyStaging(stagingDir, files) {
  for (const [assetPath, expected] of files) {
    const actual = await fs.readFile(path.join(stagingDir, assetPath));
    if (sha256(actual) !== sha256(expected)) {
      throw new Error(`staging hash mismatch: ${assetPath}`);
    }
  }
}

async function installArchive(scenario, runDir, observe) {
  const downloadDir = path.join(runDir, "download");
  const stagingDir = path.join(runDir, "staging");
  await fs.mkdir(downloadDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  const archivePath = path.join(downloadDir, "bundle.zip");
  await fs.writeFile(archivePath, scenario.archive);
  await observe(runDir);

  const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || name === "manifest.json") continue;
    await writeAsset(stagingDir, name, await entry.async("nodebuffer"));
    await observe(runDir, false);
  }
  await observe(runDir);
  await verifyStaging(stagingDir, scenario.files);
}

async function installManifest(scenario, runDir, observe) {
  const downloadDir = path.join(runDir, "download");
  const stagingDir = path.join(runDir, "staging");
  await fs.mkdir(downloadDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.writeFile(
    path.join(downloadDir, "manifest.json"),
    scenario.manifest,
  );
  for (const [assetPath, payload] of scenario.payloads) {
    await writeAsset(downloadDir, assetPath, payload.bytes);
  }
  await observe(runDir);

  for (const [assetPath, expected] of scenario.files) {
    const payload = scenario.payloads.get(assetPath);
    let bytes;
    if (!payload) {
      bytes = scenario.base.get(assetPath);
    } else if (payload.encoding === "br") {
      bytes = brotliDecompressSync(payload.bytes);
    } else if (payload.encoding === "bsdiff") {
      bytes = Buffer.from(
        await applyBsdiffPatch(scenario.base.get(assetPath), payload.bytes),
      );
    } else {
      bytes = payload.bytes;
    }
    if (!bytes || sha256(bytes) !== sha256(expected)) {
      throw new Error(`source hash mismatch: ${assetPath}`);
    }
    await writeAsset(stagingDir, assetPath, bytes);
    await observe(runDir, false);
  }
  await observe(runDir);
  await verifyStaging(stagingDir, scenario.files);
}

async function measure(scenario, protocol) {
  const times = [];
  const memoryDeltas = [];
  const diskPeaks = [];
  for (let round = 0; round < rounds; round += 1) {
    const runDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `hot-updater-${protocol}-`),
    );
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    let peakDisk = 0;
    const observe = async (dir, measureDisk = true) => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (measureDisk) {
        peakDisk = Math.max(peakDisk, await directorySize(dir));
      }
    };
    const startedAt = performance.now();
    if (protocol === "archive") {
      await installArchive(scenario, runDir, observe);
    } else {
      await installManifest(scenario, runDir, observe);
    }
    times.push(performance.now() - startedAt);
    memoryDeltas.push(Math.max(0, peakRss - initialRss));
    diskPeaks.push(peakDisk);
    await fs.rm(runDir, { force: true, recursive: true });
  }
  times.sort((left, right) => left - right);
  memoryDeltas.sort((left, right) => left - right);
  diskPeaks.sort((left, right) => left - right);
  const middle = Math.floor(rounds / 2);
  const transferBytes =
    protocol === "archive"
      ? scenario.archive.length
      : scenario.manifest.length +
        sum([...scenario.payloads.values()].map(({ bytes }) => bytes.length));
  return {
    transferBytes,
    transferRequests: protocol === "archive" ? 1 : 1 + scenario.payloads.size,
    installTimeMsMedian: Number(times[middle].toFixed(3)),
    peakTemporaryDiskBytesMedian: diskPeaks[middle],
    peakRssDeltaBytesMedian: memoryDeltas[middle],
  };
}

const android = await readTarget(
  path.join(example, "dist-benchmark-android"),
  "android",
);
const androidNext = await readTarget(
  path.join(example, "dist-benchmark-android-next"),
  "android",
);
const reusableAndroid = new Set(
  packagingEvidence.android.files
    .filter(({ result }) => result === "reusable")
    .map(({ logicalPath }) => logicalPath),
);
const bundlePath = "index.android.bundle";
const synthetic = new Map(
  Array.from({ length: 1000 }, (_, index) => {
    const assetPath = `assets/fixture-${String(index).padStart(4, "0")}.bin`;
    return [
      assetPath,
      Buffer.concat(
        Array.from({ length: 128 }, (_, chunk) =>
          createHash("sha256").update(`${assetPath}:${chunk}`).digest(),
        ),
      ),
    ];
  }),
);

const scenarios = [
  await createScenario({
    base: android,
    files: android,
    name: "js-only-first-ota-android",
    reusable: reusableAndroid,
  }),
  await createScenario({
    base: android,
    files: androidNext,
    name: "small-ota-to-ota-android",
    patchPath: bundlePath,
    reusable: new Set(
      [...androidNext.keys()].filter(
        (assetPath) =>
          sha256(android.get(assetPath)) === sha256(androidNext.get(assetPath)),
      ),
    ),
  }),
  await createScenario({
    base: new Map(),
    files: android,
    name: "empty-base-android",
    reusable: new Set(),
  }),
  await createScenario({
    base: new Map(),
    files: synthetic,
    name: "many-small-files-full-change",
    reusable: new Set(),
  }),
];

const output = {
  schemaVersion: 1,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  environment: {
    host: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    network:
      "No network latency; transfer payload bytes and request counts are exact artifact values.",
    rounds,
  },
  caveats: [
    "Install time, temporary disk, and RSS are a local Node artifact microbenchmark, not native-device p95 values.",
    "The archive baseline uses the v1 default ZIP strategy at the PRD base revision.",
    "The 1000-file fixture is deterministic synthetic stress data; the other scenarios use Release example Hermes and asset outputs.",
  ],
  scenarios: [],
};

for (const scenario of scenarios) {
  output.scenarios.push({
    name: scenario.name,
    fileCount: scenario.files.size,
    reusedFileCount: scenario.reusable.size,
    downloadedFileCount: scenario.payloads.size,
    archive: await measure(scenario, "archive"),
    manifest: await measure(scenario, "manifest"),
  });
}

console.log(`${JSON.stringify(output, null, 2)}\n`);
