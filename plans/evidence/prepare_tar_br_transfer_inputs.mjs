#!/usr/bin/env node
// Reuse the measured native fixtures byte-for-byte, adding real deployment tar.br.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { createTarBrTargetFiles } from "../../packages/cli-tools/dist/index.mjs";

const [source, output] = process.argv.slice(2);
if (!source || !output || !path.isAbsolute(source) || !path.isAbsolute(output)) {
  throw new Error("Pass absolute existing fixture and new output directories");
}
await fs.mkdir(output); // Never overwrite an existing measurement.
await fs.cp(path.join(source, "http"), path.join(output, "http"), { recursive: true });
await fs.cp(path.join(source, "fixtures"), path.join(output, "fixtures"), { recursive: true });
const scenarioPath = path.join(output, "fixtures/scenarios.json");
const scenarios = JSON.parse(await fs.readFile(scenarioPath, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const scenario of scenarios) {
  const directory = path.join(output, "http", scenario.name);
  const rawRoot = path.join(output, "raw-targets", scenario.name);
  const manifest = { bundleId: "benchmark-target", assets: {} };
  const targetFiles = [];
  for (const [name, asset] of Object.entries(scenario.assets)) {
    const payload = await fs.readFile(path.join(directory, asset.file));
    const raw = asset.compression === "br" ? brotliDecompressSync(payload) : payload;
    if (sha(raw) !== asset.fileHash) throw new Error(`Fixture hash changed: ${name}`);
    const rawPath = path.join(rawRoot, name);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, raw);
    targetFiles.push({ name, path: rawPath });
    manifest.assets[name] = {
      fileHash: asset.fileHash,
      byteSize: raw.length,
      downloadByteSize: payload.length,
      ...(asset.compression === "br" ? { downloadFileHash: sha(payload) } : {}),
    };
    if (asset.patch) asset.patch.byteSize = (await fs.stat(path.join(directory, asset.patch.file))).size;
  }
  manifest.archive = await createTarBrTargetFiles({ outfile: path.join(directory, "bundle.tar.br"), targetFiles });
  const bytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, "manifest.json"), bytes);
  scenario.manifestHash = sha(bytes);
  scenario.tarBrArchive = manifest.archive;
}
await fs.writeFile(scenarioPath, JSON.stringify(scenarios, null, 2) + "\n");
console.log(JSON.stringify(scenarios.map(({ name, tarBrArchive }) => ({ name, ...tarBrArchive })), null, 2));
