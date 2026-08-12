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

const typeCheckConsumers = async (
  packageDirectory: string,
  consumers: readonly string[],
) => {
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

  for (const consumer of consumers) {
    await execFileAsync(process.execPath, [...compilerArguments, consumer], {
      cwd: packageDirectory,
    });
  }
};

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
      directory: "cloudflare",
      packageName: "@hot-updater/cloudflare",
      exports: ["d1Database", "r2Storage"],
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
      exports: ["supabaseDatabase", "supabaseStorage"],
      absentExports: [
        "supabaseEdgeFunctionDatabase",
        "supabaseEdgeFunctionStorage",
      ],
    },
    {
      directory: "supabase",
      packageName: "@hot-updater/supabase/edge",
      exports: ["supabaseDatabase", "supabaseStorage"],
      absentExports: [
        "supabaseEdgeFunctionDatabase",
        "supabaseEdgeFunctionStorage",
      ],
    },
  ])(
    "resolves $packageName from the packed ESM and CommonJS package",
    async ({ directory, packageName, exports, absentExports, handler }) => {
      const { packageDirectory } = await packProvider(directory);
      const assertions = exports
        .map(
          (exportName) =>
            `if (typeof runtime.${exportName} !== "function") throw new Error("missing ${exportName}");`,
        )
        .join("\n");
      const absenceAssertions = (absentExports ?? [])
        .map(
          (exportName) =>
            `if (${JSON.stringify(exportName)} in runtime) throw new Error("unexpected ${exportName}");`,
        )
        .join("\n");

      await runNode(
        packageDirectory,
        `const runtime = await import(${JSON.stringify(packageName)});\n${assertions}\n${absenceAssertions}`,
        true,
      );
      await runNode(
        packageDirectory,
        `const runtime = require(${JSON.stringify(packageName)});\n${assertions}\n${absenceAssertions}`,
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

    const runtimeAssertions = `
const databaseBinding = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  batch: async (statements) => Promise.all(statements.map((statement) => statement.all())),
};
const database = runtime.d1Database(databaseBinding);
if (database.name !== "d1Database") throw new Error("invalid d1Database name");
if (typeof database.models.analytics.append !== "function") throw new Error("missing analytics model");
if (typeof database.models.clientAccessKeys.create !== "function") throw new Error("missing clientAccessKeys model");
if (typeof database.models.channels.list !== "function") throw new Error("missing channels model");
if ("d1WorkerDatabase" in runtime) throw new Error("unexpected d1WorkerDatabase");
`;
    await runNode(
      packageDirectory,
      `const runtime = await import(${JSON.stringify(moduleSpecifier)});${runtimeAssertions}`,
      true,
    );
    await runNode(
      packageDirectory,
      `const runtime = require(${JSON.stringify(moduleSpecifier)});${runtimeAssertions}`,
    );

    const moduleConsumer = path.join(packageDirectory, "consumer.mts");
    const commonJsConsumer = path.join(packageDirectory, "consumer.cts");
    const consumerSource = `import { d1Database, r2Storage } from ${JSON.stringify(
      moduleSpecifier,
    )};\ndeclare const binding: Parameters<typeof d1Database>[0];\nconst database = d1Database(binding);\nvoid database.models.bundles;\nvoid database.models.bundlePatches;\nvoid database.models.channels;\nvoid database.models.analytics;\nvoid database.models.clientAccessKeys;\nvoid database.queries.getUpdateInfo;\nvoid database.commit;\nvoid r2Storage;\n`;
    await writeFile(moduleConsumer, consumerSource);
    await writeFile(commonJsConsumer, consumerSource);

    await typeCheckConsumers(packageDirectory, [
      moduleConsumer,
      commonJsConsumer,
    ]);
  });

  it("exposes the same Supabase database name and contract from root and edge entrypoints", async () => {
    const { packageDirectory } = await packProvider("supabase");
    const rootSpecifier = "@hot-updater/supabase";
    const edgeSpecifier = "@hot-updater/supabase/edge";
    const runtimeAssertions = `
const config = {
  supabaseUrl: "https://test.supabase.invalid",
  supabaseServiceRoleKey: "test-service-role-key",
};
for (const runtime of [rootRuntime, edgeRuntime]) {
  const database = runtime.supabaseDatabase(config);
  if (database.name !== "supabaseDatabase") throw new Error("invalid supabaseDatabase name");
  if (typeof database.models.channels.list !== "function") throw new Error("missing channels model");
  if ("supabaseEdgeFunctionDatabase" in runtime) throw new Error("unexpected supabaseEdgeFunctionDatabase");
}
`;

    await runNode(
      packageDirectory,
      `const rootRuntime = await import(${JSON.stringify(rootSpecifier)});\nconst edgeRuntime = await import(${JSON.stringify(edgeSpecifier)});${runtimeAssertions}`,
      true,
    );
    await runNode(
      packageDirectory,
      `const rootRuntime = require(${JSON.stringify(rootSpecifier)});\nconst edgeRuntime = require(${JSON.stringify(edgeSpecifier)});${runtimeAssertions}`,
    );

    const moduleConsumer = path.join(packageDirectory, "supabase-consumer.mts");
    const commonJsConsumer = path.join(
      packageDirectory,
      "supabase-consumer.cts",
    );
    const consumerSource = `import { supabaseDatabase as rootDatabase } from ${JSON.stringify(
      rootSpecifier,
    )};\nimport { supabaseDatabase as edgeDatabase } from ${JSON.stringify(
      edgeSpecifier,
    )};\nconst config: Parameters<typeof rootDatabase>[0] = { supabaseUrl: "https://test.supabase.invalid", supabaseServiceRoleKey: "test-service-role-key" };\nconst edgeConfig: Parameters<typeof edgeDatabase>[0] = config;\nvoid rootDatabase(config).models.channels;\nvoid edgeDatabase(edgeConfig).models.channels;\n`;
    await writeFile(moduleConsumer, consumerSource);
    await writeFile(commonJsConsumer, consumerSource);
    await typeCheckConsumers(packageDirectory, [
      moduleConsumer,
      commonJsConsumer,
    ]);
  });
});
