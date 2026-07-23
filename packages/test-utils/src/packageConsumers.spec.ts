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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(packageDirectory, "../..");
const moduleSpecifier = "@hot-updater/test-utils";

let packedPackageDirectory: string;
let temporaryDirectory: string;

const runNode = (source: string, asModule = false) =>
  execFileAsync(
    process.execPath,
    [...(asModule ? ["--input-type=module"] : []), "--eval", source],
    { cwd: packedPackageDirectory },
  );

const runTypeScript = (consumer: string) => {
  const typescriptCli = path.join(
    workspaceRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );

  return execFileAsync(
    process.execPath,
    [
      typescriptCli,
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
    { cwd: packedPackageDirectory },
  );
};

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-test-utils-pack-"),
  );

  await execFileAsync(
    "pnpm",
    ["pack", "--pack-destination", temporaryDirectory],
    { cwd: packageDirectory },
  );

  const archive = (await readdir(temporaryDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new TypeError("pnpm pack did not create an archive");
  }

  const installDirectory = path.join(temporaryDirectory, "installed");
  await mkdir(installDirectory);
  await execFileAsync(
    "tar",
    ["-xzf", path.join(temporaryDirectory, archive), "-C", installDirectory],
    { cwd: workspaceRoot },
  );

  packedPackageDirectory = path.join(installDirectory, "package");
  await symlink(
    path.join(packageDirectory, "node_modules"),
    path.join(packedPackageDirectory, "node_modules"),
    "dir",
  );

  await access(
    path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"),
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("packed @hot-updater/test-utils consumers", () => {
  it("loads the root through its ESM import condition", async () => {
    await runNode(
      `const runtime = await import(${JSON.stringify(moduleSpecifier)});
if (typeof runtime.setupBundleMethodsTestSuite !== "function") process.exit(1);`,
      true,
    );
  });

  it("does not advertise an unsupported CommonJS root", async () => {
    await expect(
      runNode(`require.resolve(${JSON.stringify(moduleSpecifier)});`),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("loads the Node entrypoint through its ESM import condition", async () => {
    await runNode(
      `const runtime = await import(${JSON.stringify(`${moduleSpecifier}/node`)});
if (typeof runtime.hasCommand !== "function") process.exit(1);`,
      true,
    );
  });

  it("loads the Node entrypoint through its CommonJS require condition", async () => {
    await runNode(
      `const runtime = require(${JSON.stringify(`${moduleSpecifier}/node`)});
if (typeof runtime.hasCommand !== "function") process.exit(1);`,
    );
  });

  it.each([
    {
      file: "root-import.mts",
      source: `import { setupBundleMethodsTestSuite } from ${JSON.stringify(moduleSpecifier)};
void setupBundleMethodsTestSuite;`,
    },
    {
      file: "node-import.mts",
      source: `import { hasCommand } from ${JSON.stringify(`${moduleSpecifier}/node`)};
void hasCommand;`,
    },
    {
      file: "node-require.cts",
      source: `import { hasCommand } from ${JSON.stringify(`${moduleSpecifier}/node`)};
void hasCommand;`,
    },
  ])("type-checks $file with NodeNext", async ({ file, source }) => {
    const consumer = path.join(packedPackageDirectory, file);
    await writeFile(consumer, source);
    await runTypeScript(consumer);
  });

  it("does not publish source or test files", async () => {
    await expect(
      access(path.join(packedPackageDirectory, "src")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
