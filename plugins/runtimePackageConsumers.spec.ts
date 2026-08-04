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

import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

interface PackedPackage {
  packageDirectory: string;
  temporaryDirectory: string;
}

const packProvider = async (
  providerDirectory: string,
): Promise<PackedPackage> => {
  const sourceDirectory = path.join(
    workspaceRoot,
    "plugins",
    providerDirectory,
  );
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), `hot-updater-${providerDirectory}-pack-`),
  );
  temporaryDirectories.push(temporaryDirectory);

  await execFileAsync(
    "pnpm",
    ["pack", "--pack-destination", temporaryDirectory],
    { cwd: sourceDirectory },
  );

  const archive = (await readdir(temporaryDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (!archive) {
    throw new Error(
      `pnpm pack did not create an archive for ${providerDirectory}`,
    );
  }

  const installDirectory = path.join(temporaryDirectory, "installed");
  await mkdir(installDirectory);
  await execFileAsync(
    "tar",
    ["-xzf", path.join(temporaryDirectory, archive), "-C", installDirectory],
    { cwd: workspaceRoot },
  );

  const packageDirectory = path.join(installDirectory, "package");
  await symlink(
    path.join(sourceDirectory, "node_modules"),
    path.join(packageDirectory, "node_modules"),
    "dir",
  );

  return { packageDirectory, temporaryDirectory };
};

const runNode = (packageDirectory: string, source: string, asModule = false) =>
  execFileAsync(
    process.execPath,
    [...(asModule ? ["--input-type=module"] : []), "--eval", source],
    { cwd: packageDirectory },
  );

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("packed provider entrypoints", () => {
  it.each([
    {
      directory: "aws",
      packageName: "@hot-updater/aws",
      exports: ["awsLambdaEdgeStorage", "s3LambdaEdgeStorage"],
      handler: "@hot-updater/aws/lambda",
    },
    {
      directory: "firebase",
      packageName: "@hot-updater/firebase",
      exports: ["firebaseDatabase", "firebaseStorage"],
      handler: "@hot-updater/firebase/functions",
    },
    {
      directory: "postgres",
      packageName: "@hot-updater/postgres",
      exports: ["postgres"],
    },
    {
      directory: "supabase",
      packageName: "@hot-updater/supabase",
      exports: ["supabaseEdgeFunctionDatabase", "supabaseEdgeFunctionStorage"],
    },
    {
      directory: "supabase",
      packageName: "@hot-updater/supabase/edge",
      exports: ["supabaseEdgeFunctionDatabase", "supabaseEdgeFunctionStorage"],
    },
  ])(
    "resolves $packageName from the packed ESM and CommonJS package",
    async ({ directory, packageName, exports, handler }) => {
      const { packageDirectory } = await packProvider(directory);
      const assertions = exports
        .map(
          (exportName) =>
            `if (typeof runtime.${exportName} !== "function") throw new Error("missing ${exportName}");`,
        )
        .join("\n");

      await runNode(
        packageDirectory,
        `const runtime = await import(${JSON.stringify(packageName)});\n${assertions}`,
        true,
      );
      await runNode(
        packageDirectory,
        `const runtime = require(${JSON.stringify(packageName)});\n${assertions}`,
      );

      if (handler) {
        const { stdout } = await runNode(
          packageDirectory,
          `process.stdout.write(require.resolve(${JSON.stringify(handler)}));`,
        );
        expect(stdout).toMatch(/[/\\]dist[/\\].+[/\\]index\.cjs$/);
      }
    },
  );

  it("resolves the packed Cloudflare Worker entrypoint for ESM and CommonJS consumers", async () => {
    const { packageDirectory } = await packProvider("cloudflare");
    const moduleSpecifier = "@hot-updater/cloudflare/worker";

    const { stdout } = await runNode(
      packageDirectory,
      `process.stdout.write(import.meta.resolve(${JSON.stringify(moduleSpecifier)}));`,
      true,
    );
    expect(stdout).toMatch(/[/\\]dist[/\\]worker[/\\]index\.mjs$/);

    const { stdout: commonJsPath } = await runNode(
      packageDirectory,
      `process.stdout.write(require.resolve(${JSON.stringify(moduleSpecifier)}));`,
    );
    expect(commonJsPath).toMatch(/[/\\]dist[/\\]worker[/\\]index\.cjs$/);

    const moduleConsumer = path.join(packageDirectory, "consumer.mts");
    const commonJsConsumer = path.join(packageDirectory, "consumer.cts");
    const consumerSource = `import { d1Database, r2Storage } from ${JSON.stringify(
      moduleSpecifier,
    )};\nvoid d1Database;\nvoid r2Storage;\n`;
    await writeFile(moduleConsumer, consumerSource);
    await writeFile(commonJsConsumer, consumerSource);

    const typescriptCli = path.join(
      workspaceRoot,
      "node_modules",
      "typescript",
      "bin",
      "tsc6",
    );
    await access(typescriptCli);
    const compilerArguments = [
      typescriptCli,
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
    ];

    await execFileAsync(
      process.execPath,
      [...compilerArguments, moduleConsumer],
      {
        cwd: packageDirectory,
      },
    );
    await execFileAsync(
      process.execPath,
      [...compilerArguments, commonJsConsumer],
      { cwd: packageDirectory },
    );
  });
});
