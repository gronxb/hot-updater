#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";

import { createBsdiffPatch } from "../../packages/bsdiff/dist/internal/bsdiff.js";
import JSZip from "../../packages/cli-tools/node_modules/jszip/lib/index.js";
import "../../packages/bsdiff/dist/node.js";
import { bare } from "../../plugins/bare/dist/index.mjs";

const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error("Pass an absolute output directory");
const example = path.resolve(import.meta.dirname, "../../examples/v0.85.0");
const markerPath = path.join(example, "src/e2eApp/patchSurface.ts");
const original = await fs.readFile(markerPath, "utf8");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const builds = [];
try {
  for (const marker of ["native-benchmark-base", "native-benchmark-target"]) {
    await fs.writeFile(
      markerPath,
      original.replace(
        /export const E2E_SCENARIO_MARKER = "[^"]*";/,
        `export const E2E_SCENARIO_MARKER = "${marker}";`,
      ),
    );
    const outDir = path.join(output, marker);
    await bare({
      enableHermes: true,
      outDir: path.relative(example, outDir),
      resetCache: false,
    })({ cwd: example }).build({ platform: "ios" });
    const files = new Map();
    async function visit(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (/\.(png|ttf)$/.test(entry.name))
          files.set(
            path.relative(outDir, absolute),
            await fs.readFile(absolute),
          );
      }
    }
    await visit(outDir);
    files.set(
      "index.ios.bundle",
      await fs.readFile(path.join(outDir, "index.ios.bundle.hbc")),
    );
    builds.push(files);
  }
} finally {
  await fs.writeFile(markerPath, original);
}
const [base, target] = builds;
const synthetic = new Map(
  Array.from({ length: 1000 }, (_, i) => {
    const name = i === 0 ? "index.ios.bundle" : `assets/file-${i}.bin`;
    return [
      name,
      Buffer.concat(
        Array.from({ length: 128 }, (_, j) =>
          createHash("sha256").update(`${i}:${j}`).digest(),
        ),
      ),
    ];
  }),
);
const scenarios = [];
for (const [name, files, mode] of [
  ["first-js-only", target, "builtin"],
  ["small-ota-patch", target, "ota"],
  ["empty-base", target, "empty"],
  ["1000-full-change", synthetic, "empty"],
]) {
  const dir = path.join(output, "http", name);
  const manifest = Buffer.from(
    JSON.stringify({
      bundleId: "benchmark-target",
      assets: Object.fromEntries(
        [...files].map(([p, b]) => [p, { fileHash: sha(b) }]),
      ),
    }),
  );
  const zip = new JSZip();
  zip.file("manifest.json", manifest);
  await fs.mkdir(path.join(dir, "payload"), { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), manifest);
  const assets = {};
  let i = 0;
  for (const [p, b] of files) {
    zip.file(p, b);
    const payload = p.endsWith(".bundle") ? brotliCompressSync(b) : b;
    const name = `payload/${i++}`;
    await fs.writeFile(path.join(dir, name), payload);
    assets[p] = {
      file: name,
      fileHash: sha(b),
      compression: p.endsWith(".bundle") ? "br" : null,
    };
    if (mode === "ota" && p.endsWith(".bundle")) {
      const patch = Buffer.from(await createBsdiffPatch(base.get(p), b));
      if (patch.length >= payload.length)
        throw new Error("Fixture patch must be smaller than the original");
      await fs.writeFile(path.join(dir, "patch.bsdiff"), patch);
      assets[p].patch = {
        baseHash: sha(base.get(p)),
        hash: sha(patch),
        file: "patch.bsdiff",
      };
    }
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });
  await fs.writeFile(path.join(dir, "bundle.zip"), archive);
  const baseFiles = {};
  if (mode !== "empty") {
    for (const [p, b] of base) {
      const location = path.join(
        output,
        "fixtures",
        name,
        "base",
        p === "index.ios.bundle" && mode === "builtin" ? "main.jsbundle" : p,
      );
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(location, b);
      baseFiles[p] = sha(b);
    }
    if (mode === "builtin")
      await fs.writeFile(
        path.join(output, "fixtures", name, "base", "Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.hotupdater.benchmark.fixture</string><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>',
      );
    else
      await fs.writeFile(
        path.join(output, "fixtures", name, "base", "manifest.json"),
        JSON.stringify({
          bundleId: "benchmark-base",
          assets: Object.fromEntries(
            Object.entries(baseFiles).map(([p, fileHash]) => [p, { fileHash }]),
          ),
        }),
      );
  }
  scenarios.push({
    name,
    mode,
    manifestHash: sha(manifest),
    archiveHash: sha(archive),
    assets,
  });
}
await fs.mkdir(path.join(output, "fixtures"), { recursive: true });
await fs.writeFile(
  path.join(output, "fixtures", "scenarios.json"),
  JSON.stringify(scenarios, null, 2),
);
console.log(
  JSON.stringify({
    output,
    scenarios: scenarios.map(({ name, assets }) => ({
      name,
      files: Object.keys(assets).length,
    })),
  }),
);
