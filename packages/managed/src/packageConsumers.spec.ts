import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = path.resolve(import.meta.dirname, "..");
let installedPackageDirectory: string;
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-managed-package-"),
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
    throw new TypeError("pnpm pack did not create a managed preset archive.");
  }
  await execFileAsync(
    "tar",
    ["-xzf", path.join(packDirectory, archive), "-C", installDirectory],
    { cwd: packageDirectory },
  );
  installedPackageDirectory = path.join(installDirectory, "package");
  await symlink(
    path.join(packageDirectory, "node_modules"),
    path.join(installedPackageDirectory, "node_modules"),
    "dir",
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("packed @hot-updater/managed consumers", () => {
  it.each([
    { asModule: true, condition: "ESM import" },
    { asModule: false, condition: "CommonJS require" },
  ])("loads the managed preset through $condition", async ({ asModule }) => {
    const load = asModule
      ? 'await import("@hot-updater/managed")'
      : 'require("@hot-updater/managed")';
    await execFileAsync(
      process.execPath,
      [
        ...(asModule ? ["--input-type=module"] : []),
        "--eval",
        `const runtime = ${load};
const plugins = runtime.createManagedServerPlugins();
const ids = plugins.map(({ id }) => id).join(",");
if (ids !== "better-auth-managed-access-key,managed-auth-route-policy,analytics") throw new Error("invalid managed preset");
if (plugins[0]?.schema?.id !== "better-auth-managed-access-keys") throw new Error("missing Better Auth schema");
if (plugins[2]?.schema?.id !== "analytics") throw new Error("missing Analytics schema");
if (typeof runtime.registerManagedServerClientKey !== "function") throw new Error("missing client-key registration");`,
      ],
      { cwd: installedPackageDirectory },
    );
  });

  it.each([
    { asModule: true, condition: "ESM import" },
    { asModule: false, condition: "CommonJS require" },
  ])(
    "loads managed deployment preparation through $condition",
    async ({ asModule }) => {
      const load = asModule
        ? 'await import("@hot-updater/managed/deployment")'
        : 'require("@hot-updater/managed/deployment")';
      await execFileAsync(
        process.execPath,
        [
          ...(asModule ? ["--input-type=module"] : []),
          "--eval",
          `const deployment = ${load};
if (typeof deployment.prepareManagedServerDeployment !== "function") throw new Error("missing managed deployment preparation");`,
        ],
        { cwd: installedPackageDirectory },
      );
    },
  );
});
