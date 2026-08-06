import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(packageDirectory, "../..");
let installedPackageDirectory: string | undefined;
let temporaryDirectory: string | undefined;

const getInstalledPackageDirectory = (): string => {
  if (installedPackageDirectory === undefined) {
    throw new TypeError("Packed Analytics package is not ready.");
  }
  return installedPackageDirectory;
};

const runPackedNode = (source: string, module = false) =>
  execFileAsync(
    process.execPath,
    [...(module ? ["--input-type=module"] : []), "--eval", source],
    { cwd: getInstalledPackageDirectory() },
  );

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-analytics-package-"),
  );
  const packDirectory = path.join(temporaryDirectory, "pack");
  const installDirectory = path.join(temporaryDirectory, "installed");
  await Promise.all([mkdir(packDirectory), mkdir(installDirectory)]);
  await execFileAsync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: packageDirectory,
  });
  const archive = (await readdir(packDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new TypeError("pnpm pack did not create an Analytics archive.");
  }
  await execFileAsync(
    "tar",
    ["-xzf", path.join(packDirectory, archive), "-C", installDirectory],
    { cwd: workspaceRoot },
  );
  installedPackageDirectory = path.join(installDirectory, "package");
  await symlink(
    path.join(packageDirectory, "node_modules"),
    path.join(installedPackageDirectory, "node_modules"),
    "dir",
  );
});

afterAll(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

describe("packed Analytics package", () => {
  it.each([
    ["@hot-updater/analytics", "analytics"],
    ["@hot-updater/analytics/provider", "createBoundedAnalyticsProvider"],
    ["@hot-updater/analytics/provider", "createBlobAnalyticsPersistence"],
    [
      "@hot-updater/analytics/adapters/kysely",
      "createKyselyAnalyticsPersistence",
    ],
    [
      "@hot-updater/analytics/adapters/mongodb",
      "createMongoAnalyticsPersistence",
    ],
  ] as const)("loads %s#%s in ESM and CommonJS", async (specifier, name) => {
    const check = `const value = runtime[${JSON.stringify(name)}];
if (typeof value !== "function") throw new TypeError("missing export");`;
    await runPackedNode(
      `const runtime = await import(${JSON.stringify(specifier)});\n${check}`,
      true,
    );
    await runPackedNode(
      `const runtime = require(${JSON.stringify(specifier)});\n${check}`,
    );
  });

  it("does not expose private source modules", async () => {
    await expect(
      runPackedNode('require("@hot-updater/analytics/provider/migration");'),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("ERR_PACKAGE_PATH_NOT_EXPORTED"),
    });
  });

  it.each(["mts", "cts"] as const)(
    "type-checks a NodeNext %s consumer",
    async (extension) => {
      const consumer = path.join(
        getInstalledPackageDirectory(),
        `analytics-consumer.${extension}`,
      );
      await writeFile(
        consumer,
        `import { analytics } from "@hot-updater/analytics";
import { createBoundedAnalyticsProvider, type AnalyticsPersistence } from "@hot-updater/analytics/provider";
const persistence: AnalyticsPersistence = { append: async () => undefined, scan: async () => [] };
void analytics({ provider: createBoundedAnalyticsProvider(persistence) });`,
      );
      await execFileAsync(
        process.execPath,
        [
          path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc6"),
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
        { cwd: getInstalledPackageDirectory() },
      );
      expect(await readFile(consumer, "utf8")).toContain(
        "analytics({ provider",
      );
    },
  );
});
