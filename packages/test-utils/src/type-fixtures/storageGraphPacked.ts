import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { StorageGraphCell } from "./storageGraphMatrix.fixture";
import type { StorageGraphManifest } from "./storageGraphPolicy";

const execFileAsync = promisify(execFile);

export const storageGraphCanaries = [
  "TODO21_AWS_SECRET_7f6e9c1d",
  "TODO21_FIREBASE_SECRET_42bd5a80",
  "TODO21_EDGE_SECRET_d8a371ce",
] as const;

const packageLocations = [
  "packages/core",
  "plugins/js",
  "plugins/plugin-core",
  "plugins/mock",
  "plugins/aws",
  "plugins/cloudflare",
  "plugins/firebase",
  "plugins/supabase",
  "plugins/standalone",
] as const;

type PackageMetadata = Readonly<{
  dependencies: readonly string[];
  name: string;
}>;

type PackedPackage = Readonly<{
  metadata: PackageMetadata;
  root: string;
  sourceRoot: string;
}>;

export type PackedStorageGraph = Readonly<{
  createManifest: (cell: StorageGraphCell) => Promise<StorageGraphManifest>;
  dispose: () => Promise<void>;
  findCanaryLeaks: () => Promise<readonly string[]>;
}>;

const metadataFor = async (root: string): Promise<PackageMetadata> => {
  const value: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Invalid package metadata: ${root}`);
  }
  const name = Reflect.get(value, "name");
  const dependencies = Reflect.get(value, "dependencies");
  const peerDependencies = Reflect.get(value, "peerDependencies");
  if (typeof name !== "string") {
    throw new TypeError(`Missing package name: ${root}`);
  }
  const dependencyNames = [dependencies, peerDependencies].flatMap((record) =>
    typeof record === "object" && record !== null ? Object.keys(record) : [],
  );
  return { dependencies: [...new Set(dependencyNames)], name };
};

const linkPackage = async (
  nodeModules: string,
  name: string,
  target: string,
): Promise<void> => {
  const destination = path.join(nodeModules, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, "dir");
};

const packOne = async (
  workspaceRoot: string,
  temporaryRoot: string,
  location: string,
): Promise<PackedPackage> => {
  const sourceRoot = path.join(workspaceRoot, location);
  const packRoot = path.join(
    temporaryRoot,
    "packs",
    location.replaceAll("/", "-"),
  );
  const extractRoot = path.join(packRoot, "extracted");
  await mkdir(extractRoot, { recursive: true });
  await execFileAsync("pnpm", ["pack", "--pack-destination", packRoot], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOT_UPDATER_AWS_SECRET: storageGraphCanaries[0],
      HOT_UPDATER_FIREBASE_SECRET: storageGraphCanaries[1],
      HOT_UPDATER_EDGE_SECRET: storageGraphCanaries[2],
    },
  });
  const archive = (await readdir(packRoot)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new TypeError(`Missing packed archive: ${location}`);
  }
  await execFileAsync(
    "tar",
    ["-xzf", path.join(packRoot, archive), "-C", extractRoot],
    { cwd: workspaceRoot },
  );
  const root = path.join(extractRoot, "package");
  return { metadata: await metadataFor(root), root, sourceRoot };
};

const walkFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const target = path.join(root, entry.name);
      if (entry.isSymbolicLink()) {
        return [];
      }
      return entry.isDirectory() ? walkFiles(target) : [target];
    }),
  );
  return files.flat();
};

export const createPackedStorageGraph = async (
  workspaceRoot: string,
): Promise<PackedStorageGraph> => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-storage-graph-"),
  );
  const packages = await Promise.all(
    packageLocations.map((location) =>
      packOne(workspaceRoot, temporaryRoot, location),
    ),
  );
  const packedByName = new Map(
    packages.map((item) => [item.metadata.name, item]),
  );
  for (const item of packages) {
    const nodeModules = path.join(item.root, "node_modules");
    await mkdir(nodeModules);
    for (const dependency of item.metadata.dependencies) {
      const packed = packedByName.get(dependency);
      const target =
        packed?.root ?? path.join(item.sourceRoot, "node_modules", dependency);
      await access(target);
      await linkPackage(nodeModules, dependency, target);
    }
  }
  const consumerRoot = path.join(temporaryRoot, "consumer");
  const consumerNodeModules = path.join(consumerRoot, "node_modules");
  await mkdir(consumerNodeModules, { recursive: true });
  for (const [name, item] of packedByName) {
    await linkPackage(consumerNodeModules, name, item.root);
  }
  const parent = path.join(consumerRoot, "entry.mjs");
  await writeFile(parent, "");
  const driver = path.join(
    import.meta.dirname,
    "fixtures/storageGraphDriver.mjs",
  );
  return {
    createManifest: async (cell) => {
      const requestPath = path.join(temporaryRoot, `${cell.id}.json`);
      await writeFile(
        requestPath,
        JSON.stringify({
          packedRoots: packages.map(({ metadata, root }) => ({
            name: metadata.name,
            root,
          })),
          neutral: cell.conditions.includes("neutral"),
          parentUrl: pathToFileURL(parent).href,
          specifier: cell.specifier,
        }),
      );
      const conditionArguments = cell.conditions
        .filter((condition) => condition !== "neutral")
        .flatMap((condition) => [`--conditions=${condition}`]);
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--experimental-import-meta-resolve",
          ...conditionArguments,
          driver,
          requestPath,
        ],
        { cwd: consumerRoot, maxBuffer: 10 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    },
    dispose: () => rm(temporaryRoot, { force: true, recursive: true }),
    findCanaryLeaks: async () => {
      const leaks: string[] = [];
      for (const item of packages) {
        const files = await walkFiles(item.root);
        for (const file of files) {
          const content = await readFile(file);
          const text = content.toString("utf8");
          for (const canary of storageGraphCanaries) {
            if (text.includes(canary)) {
              leaks.push(
                `${item.metadata.name}:${path.relative(item.root, file)}`,
              );
            }
          }
        }
      }
      return leaks;
    },
  };
};
