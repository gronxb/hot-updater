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
const moduleSpecifier = "@hot-updater/better-auth";

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
    "tsc6",
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
    path.join(os.tmpdir(), "hot-updater-better-auth-pack-"),
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
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("packed @hot-updater/better-auth consumers", () => {
  it.each([
    { asModule: true, condition: "ESM import" },
    { asModule: false, condition: "CommonJS require" },
  ])(
    "loads every runtime subpath through the $condition condition",
    async ({ asModule }) => {
      const load = asModule
        ? (specifier: string) => `await import(${JSON.stringify(specifier)})`
        : (specifier: string) => `require(${JSON.stringify(specifier)})`;
      await runNode(
        `const root = ${load(moduleSpecifier)};
const managed = ${load(`${moduleSpecifier}/managed`)};
const provisioning = ${load(`${moduleSpecifier}/managed/provisioning`)};
if (typeof root.betterAuthPlugin !== "function") throw new Error("missing root plugin");
if (typeof managed.managedBetterAuthPlugin !== "function") throw new Error("missing managed plugin");
if (typeof managed.managedRoutePolicy !== "function") throw new Error("missing policy plugin");
if (typeof managed.createUniversalComponentManagedAccessKeyStore !== "function") throw new Error("missing component store");
if (managed.managedAccessKeyComponentSchema?.id !== "better-auth-managed-access-keys") throw new Error("missing component schema");
if (typeof provisioning.provisionManagedBetterAuthApiKey !== "function") throw new Error("missing provisioning");
if (typeof provisioning.createManagedBetterAuthApiKey !== "function") throw new Error("missing key creation");`,
        asModule,
      );
    },
  );

  it("serializes packed Node provisioning across processes", async () => {
    const environmentFile = path.join(temporaryDirectory, "consumer.env");
    const source = `globalThis.fetch = () => { throw new Error("unexpected network call"); };
const { stat } = await import("node:fs/promises");
const { provisionManagedBetterAuthApiKey } = await import(${JSON.stringify(
      `${moduleSpecifier}/managed/provisioning`,
    )});
const result = await provisionManagedBetterAuthApiKey({ envFilePath: ${JSON.stringify(
      environmentFile,
    )} });
const mode = (await stat(${JSON.stringify(environmentFile)})).mode & 0o777;
process.stdout.write(JSON.stringify({ ...result, mode }));`;
    const outputs = await Promise.all(
      [runNode(source, true), runNode(source, true)].map((pending) =>
        pending.then(({ stdout }) => JSON.parse(stdout)),
      ),
    );

    expect(outputs[0]?.apiKey).toBe(outputs[1]?.apiKey);
    expect(outputs[0]?.sha256).toBe(outputs[1]?.sha256);
    expect(outputs.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(outputs.map(({ mode }) => mode)).toEqual([0o600, 0o600]);
  });

  it.each([
    {
      file: "root-import.mts",
      source: `import { betterAuthPlugin, type BetterAuthSession } from ${JSON.stringify(
        moduleSpecifier,
      )};\nvoid betterAuthPlugin;\nvoid (undefined as BetterAuthSession | undefined);`,
    },
    {
      file: "managed-require.cts",
      source: `import { createUniversalComponentManagedAccessKeyStore, managedAccessKeyComponentSchema, managedBetterAuthPlugin, managedRoutePolicy } from ${JSON.stringify(
        `${moduleSpecifier}/managed`,
      )};\nvoid createUniversalComponentManagedAccessKeyStore;\nvoid managedAccessKeyComponentSchema;\nvoid managedBetterAuthPlugin;\nvoid managedRoutePolicy;`,
    },
    {
      file: "provisioning-import.mts",
      source: `import { createManagedBetterAuthApiKey, provisionManagedBetterAuthApiKey, type CreatedManagedBetterAuthApiKey, type ProvisionedManagedBetterAuthApiKey } from ${JSON.stringify(
        `${moduleSpecifier}/managed/provisioning`,
      )};\nvoid createManagedBetterAuthApiKey;\nvoid provisionManagedBetterAuthApiKey;\nvoid (undefined as CreatedManagedBetterAuthApiKey | ProvisionedManagedBetterAuthApiKey | undefined);`,
    },
  ])("type-checks $file with NodeNext", async ({ file, source }) => {
    const consumer = path.join(packedPackageDirectory, file);
    await writeFile(consumer, source);
    await runTypeScript(consumer);
  });

  it("keeps Node provisioning out of browser-compatible entrypoints", async () => {
    const browserConsumer = path.join(packedPackageDirectory, "browser.mjs");
    const browserOutput = path.join(temporaryDirectory, "browser-output.mjs");
    const provisioningConsumer = path.join(
      packedPackageDirectory,
      "browser-provisioning.mjs",
    );
    const esbuild = path.join(
      packageDirectory,
      "node_modules",
      ".bin",
      "esbuild",
    );
    await writeFile(
      browserConsumer,
      `import { betterAuthPlugin } from ${JSON.stringify(moduleSpecifier)};
import { managedRoutePolicy } from ${JSON.stringify(`${moduleSpecifier}/managed`)};
void betterAuthPlugin;
void managedRoutePolicy;`,
    );
    await writeFile(
      provisioningConsumer,
      `import { provisionManagedBetterAuthApiKey } from ${JSON.stringify(
        `${moduleSpecifier}/managed/provisioning`,
      )};\nvoid provisionManagedBetterAuthApiKey;`,
    );

    await execFileAsync(
      esbuild,
      [
        browserConsumer,
        "--bundle",
        "--platform=browser",
        "--format=esm",
        `--outfile=${browserOutput}`,
      ],
      { cwd: packedPackageDirectory },
    );
    await expect(
      execFileAsync(
        esbuild,
        [
          provisioningConsumer,
          "--bundle",
          "--platform=browser",
          "--format=esm",
          `--outfile=${path.join(temporaryDirectory, "provisioning-output.mjs")}`,
        ],
        { cwd: packedPackageDirectory },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await access(browserOutput);
    await expect(
      access(path.join(packedPackageDirectory, "src")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
