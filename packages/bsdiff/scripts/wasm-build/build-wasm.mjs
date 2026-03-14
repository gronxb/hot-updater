#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = findProjectRoot(__dirname);
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const cargoBin = config.tools?.cargo || "cargo";
const rustupBin = config.tools?.rustup || "rustup";
const target = resolveBuildTarget(config.wasm || {});
const missingRustTools = getMissingRustTools(cargoBin, rustupBin);

if (missingRustTools.length > 0) {
  if (!existsSync(target.outputWasm)) {
    throw new Error(
      `[wasm] missing Rust toolchain binaries (${missingRustTools.join(", ")}). Install rustup/cargo or restore precompiled wasm at ${target.outputWasm}`,
    );
  }

  console.log(
    `[wasm] skipping Rust build; missing binaries: ${missingRustTools.join(", ")}`,
  );
  console.log(`[wasm] using precompiled ${target.outputWasm}`);
  console.log(`[wasm] sha256 ${sha256File(target.outputWasm)}`);
  process.exit(0);
}

ensureRustTargetInstalled(rustupBin, target.rustTarget);

console.log(`[wasm] building ${target.manifestPath}`);
execFileSync(cargoBin, [
  "build",
  "--manifest-path",
  target.manifestPath,
  "--target",
  target.rustTarget,
  "--release",
], {
  stdio: "inherit",
});

if (!existsSync(target.sourceWasm)) {
  throw new Error(
    `[wasm] build succeeded but wasm output is missing: ${target.sourceWasm}`,
  );
}

mkdirSync(path.dirname(target.outputWasm), { recursive: true });
cpSync(target.sourceWasm, target.outputWasm);

console.log(`[wasm] copied ${target.sourceWasm} -> ${target.outputWasm}`);
console.log(`[wasm] sha256 ${sha256File(target.outputWasm)}`);

function resolveBuildTarget(targetConfig) {
  const crateDir = resolvePath(targetConfig.crateDir || "rust/hdiff-wasm");
  const rustTarget = targetConfig.rustTarget || "wasm32-unknown-unknown";
  const manifestPath = resolvePath(targetConfig.manifestPath || path.join(crateDir, "Cargo.toml"));
  const crateName = targetConfig.crateName || readCargoPackageName(manifestPath);
  const wasmFileName = targetConfig.wasmFileName || `${crateName.replaceAll("-", "_")}.wasm`;

  const sourceWasm = resolvePath(
    targetConfig.sourceWasm || path.join(crateDir, "target", rustTarget, "release", wasmFileName)
  );

  const outputWasm = resolvePath(targetConfig.outputWasm || "assets/hdiff.wasm");

  return {
    rustTarget,
    manifestPath,
    sourceWasm,
    outputWasm,
  };
}

function ensureRustTargetInstalled(rustup, target) {
  let installedTargets;
  try {
    installedTargets = execFileSync(rustup, ["target", "list", "--installed"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`[wasm] ${rustup} is required to build wasm. Original error: ${String(error)}`);
  }

  const installed = new Set(installedTargets.split(/\r?\n/).filter(Boolean));
  if (installed.has(target)) {
    return;
  }

  console.log(`[wasm] installing rust target: ${target}`);
  execFileSync(rustup, ["target", "add", target], { stdio: "inherit" });
}

function getMissingRustTools(cargo, rustup) {
  const missing = [];
  if (!canRun(cargo, ["--version"])) {
    missing.push(cargo);
  }
  if (!canRun(rustup, ["--version"])) {
    missing.push(rustup);
  }
  return missing;
}

function canRun(bin, args) {
  try {
    execFileSync(bin, args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function readCargoPackageName(manifestPath) {
  const raw = readFileSync(manifestPath, "utf8");
  const packageSection = raw.match(/\[package\]([\s\S]*?)(?:\n\s*\[|$)/)?.[1] ?? "";
  const name = packageSection.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) {
    throw new Error(`[wasm] unable to resolve crate name from ${manifestPath}`);
  }
  return name;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function findProjectRoot(startDir) {
  let cursor = startDir;
  while (true) {
    if (existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`[wasm] unable to find project root from ${startDir}`);
    }
    cursor = parent;
  }
}
