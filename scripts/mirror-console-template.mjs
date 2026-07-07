import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const consoleTemplateDir = path.join(repoRoot, "templates", "console");

const ignoredNames = new Set([
  ".DS_Store",
  ".nitro",
  ".output",
  ".tanstack",
  ".wrangler",
  "dist",
  "node_modules",
  "pnpm-lock.yaml",
]);

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

const assertSafeTarget = (targetDir) => {
  const resolvedSource = path.resolve(consoleTemplateDir);
  const resolvedTarget = path.resolve(targetDir);
  const rootDir = path.parse(resolvedTarget).root;

  if (
    resolvedTarget === resolvedSource ||
    isInside(resolvedSource, resolvedTarget)
  ) {
    throw new Error("Mirror target must be outside templates/console.");
  }

  if (resolvedTarget === rootDir || resolvedTarget === os.homedir()) {
    throw new Error("Mirror target must not be a filesystem root or home.");
  }

  if (resolvedTarget === repoRoot || isInside(repoRoot, resolvedTarget)) {
    throw new Error("Mirror target must be outside this repository.");
  }
};

const shouldSkip = (entryName) => ignoredNames.has(entryName);

const walkFiles = async (dir, root = dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (shouldSkip(entry.name)) {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolutePath, root));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
};

export const listTemplateFiles = () => walkFiles(consoleTemplateDir);

export const hashFile = async (filePath) => {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
};

export const buildManifest = async (dir) => {
  const files = await walkFiles(dir);
  const entries = await Promise.all(
    files.map(async (file) => {
      const hash = await hashFile(path.join(dir, file));
      return [file, hash];
    }),
  );

  return Object.fromEntries(entries);
};

export const compareManifests = (sourceManifest, targetManifest) => {
  const sourceFiles = Object.keys(sourceManifest);
  const targetFiles = Object.keys(targetManifest);
  const allFiles = new Set([...sourceFiles, ...targetFiles]);
  const mismatches = [];

  for (const file of [...allFiles].sort((left, right) =>
    left.localeCompare(right)
  )) {
    if (sourceManifest[file] !== targetManifest[file]) {
      mismatches.push(file);
    }
  }

  return mismatches;
};

export const mirrorConsoleTemplate = async ({ clean = false, targetDir } = {}) => {
  if (!targetDir) {
    throw new Error("Pass --target <dir> or set HOT_UPDATER_CONSOLE_MIRROR_DIR.");
  }

  const resolvedTarget = path.resolve(targetDir);
  assertSafeTarget(resolvedTarget);

  if (clean) {
    await rm(resolvedTarget, { force: true, recursive: true });
  }

  await mkdir(path.dirname(resolvedTarget), { recursive: true });
  await cp(consoleTemplateDir, resolvedTarget, {
    force: true,
    recursive: true,
    filter: async (source) => {
      const name = path.basename(source);
      if (shouldSkip(name)) {
        return false;
      }

      const sourceStat = await stat(source);
      return sourceStat.isDirectory() || sourceStat.isFile();
    },
  });

  const sourceManifest = await buildManifest(consoleTemplateDir);
  const targetManifest = await buildManifest(resolvedTarget);
  const mismatches = compareManifests(sourceManifest, targetManifest);

  return {
    fileCount: Object.keys(sourceManifest).length,
    mismatches,
    sourceDir: consoleTemplateDir,
    targetDir: resolvedTarget,
  };
};

const parseArgs = (args) => {
  const options = {
    clean: false,
    targetDir: process.env.HOT_UPDATER_CONSOLE_MIRROR_DIR,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--clean") {
      options.clean = true;
      continue;
    }

    if (arg === "--target") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("Pass a directory after --target.");
      }

      options.targetDir = args[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const isDirectRun = () => {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (isDirectRun()) {
  const options = parseArgs(process.argv.slice(2));
  const targetDir =
    options.targetDir ?? path.join(os.tmpdir(), "hot-updater-console-template");
  const result = await mirrorConsoleTemplate({ ...options, targetDir });

  if (result.mismatches.length > 0) {
    throw new Error(`Mirror drift detected: ${result.mismatches.join(", ")}`);
  }

  console.log(
    `Mirrored ${result.fileCount} files from ${result.sourceDir} to ${result.targetDir}`,
  );
}
