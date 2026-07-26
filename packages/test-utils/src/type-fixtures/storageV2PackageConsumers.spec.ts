import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const testUtilsDirectory = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(testUtilsDirectory, "../..");
const pluginCoreDirectory = path.join(workspaceRoot, "plugins/plugin-core");

let consumerDirectory: string;
let temporaryDirectory: string;

const packAndExtract = async (
  packageDirectory: string,
  name: string,
): Promise<string> => {
  const packDirectory = path.join(temporaryDirectory, `${name}-pack`);
  const extractDirectory = path.join(temporaryDirectory, `${name}-extract`);
  await mkdir(packDirectory);
  await mkdir(extractDirectory);
  await execFileAsync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: packageDirectory,
  });
  const archive = (await readdir(packDirectory)).find((entry) =>
    entry.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new TypeError(`Missing packed archive for ${name}.`);
  }
  await execFileAsync(
    "tar",
    ["-xzf", path.join(packDirectory, archive), "-C", extractDirectory],
    { cwd: workspaceRoot },
  );
  return path.join(extractDirectory, "package");
};

const linkScopedPackage = async (
  nodeModules: string,
  name: string,
  target: string,
): Promise<void> => {
  const destination = path.join(nodeModules, "@hot-updater", name);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, "dir");
};

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-storage-v2-pack-"),
  );
  const testUtilsPackage = await packAndExtract(
    testUtilsDirectory,
    "test-utils",
  );
  const pluginCorePackage = await packAndExtract(
    pluginCoreDirectory,
    "plugin-core",
  );
  consumerDirectory = path.join(temporaryDirectory, "consumer");
  const consumerNodeModules = path.join(consumerDirectory, "node_modules");
  await mkdir(consumerNodeModules, { recursive: true });
  await linkScopedPackage(consumerNodeModules, "test-utils", testUtilsPackage);
  await linkScopedPackage(
    consumerNodeModules,
    "plugin-core",
    pluginCorePackage,
  );
  await symlink(
    path.join(testUtilsDirectory, "node_modules"),
    path.join(testUtilsPackage, "node_modules"),
    "dir",
  );
  await access(path.join(testUtilsPackage, "dist/storage.mjs"));
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("packed Storage v2 test-utils consumers", () => {
  it("imports conformance helpers from the ESM root", async () => {
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const api = await import("@hot-updater/test-utils");
if (typeof api.setupStoragePluginTestSuite !== "function") process.exit(1);`,
      ],
      { cwd: consumerDirectory },
    );
  });

  it("imports the Storage subpath from ESM", async () => {
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const api = await import("@hot-updater/test-utils/storage");
if (typeof api.createMemoryStoragePlugin !== "function") process.exit(1);`,
      ],
      { cwd: consumerDirectory },
    );
  });

  it("imports the Storage subpath from CommonJS", async () => {
    await execFileAsync(
      process.execPath,
      [
        "--eval",
        `void import("@hot-updater/test-utils/storage").then((api) => {
  if (typeof api.createMemoryStoragePlugin !== "function") process.exit(1);
});`,
      ],
      { cwd: consumerDirectory },
    );
  });

  it.each(["storage-consumer.mts", "storage-consumer.cts"])(
    "type-checks %s with NodeNext",
    async (file) => {
      const consumer = path.join(consumerDirectory, file);
      const source = file.endsWith(".cts")
        ? `type StorageApi = typeof import("@hot-updater/test-utils/storage");
const load = async (): Promise<StorageApi> =>
  import("@hot-updater/test-utils/storage");
void load;`
        : `import {
  createMemoryStoragePlugin,
  setupStoragePluginTestSuite,
} from "@hot-updater/test-utils/storage";
const plugin = createMemoryStoragePlugin();
void plugin.get;
void setupStoragePluginTestSuite;`;
      await writeFile(consumer, source);
      await execFileAsync(
        process.execPath,
        [
          path.join(workspaceRoot, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          "--strict",
          "--skipLibCheck",
          consumer,
        ],
        { cwd: consumerDirectory },
      );
    },
  );
});
