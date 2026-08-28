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
  it("inlines plugin-core's semver runtime for native app bundlers", async () => {
    const { packageDirectory } = await packProvider("plugin-core");

    for (const file of [
      "releaseCatalogCompiler.cjs",
      "releaseCatalogCompiler.mjs",
      "semverSatisfies.cjs",
      "semverSatisfies.mjs",
    ]) {
      const source = await readFile(
        path.join(packageDirectory, "dist", file),
        "utf8",
      );
      expect(source).not.toMatch(/(?:from\s+|require\()(["'])verkit\1/);
    }
  });

  it.each([
    {
      directory: "aws",
      packageName: "@hot-updater/aws",
      exports: ["cloudFrontDownloadUrl", "kmsSigning", "s3Storage"],
      handler: "@hot-updater/aws/lambda",
    },
    {
      directory: "cloudflare",
      packageName: "@hot-updater/cloudflare",
      exports: ["d1Database", "r2Storage", "workerSigning"],
    },
    {
      directory: "firebase",
      packageName: "@hot-updater/firebase",
      exports: ["firebaseDatabase", "firebaseKmsSigning", "firebaseStorage"],
      absentExports: ["firebaseStorageDelivery"],
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
      exports: ["edgeFunctionSigning", "supabaseDatabase", "supabaseStorage"],
      absentExports: [
        "supabaseEdgeFunctionDatabase",
        "supabaseEdgeFunctionStorage",
        "supabaseStorageDelivery",
      ],
    },
    {
      directory: "supabase",
      packageName: "@hot-updater/supabase/edge",
      exports: ["supabaseDatabase", "supabaseStorage"],
      absentExports: [
        "createEdgeFunctionSigningHandler",
        "supabaseEdgeFunctionDatabase",
        "supabaseEdgeFunctionStorage",
        "supabaseStorageDelivery",
      ],
    },
    {
      directory: "supabase",
      packageName: "@hot-updater/supabase/edge/signing",
      exports: ["createEdgeFunctionSigningHandler"],
      absentExports: ["supabaseDatabase", "supabaseStorage"],
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
    const rootSpecifier = "@hot-updater/cloudflare";
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
const rootStorage = rootRuntime.r2Storage({
  accountId: "account-id",
  bucketName: "updates",
  credentials: {
    accessKeyId: "access-key-id",
    secretAccessKey: "secret-access-key",
  },
});
if (rootStorage.name !== "r2Storage") throw new Error("invalid root r2Storage name");
for (const operation of ["put", "get", "exists", "delete"]) {
  if (typeof rootStorage[operation] !== "function") throw new Error("missing root storage " + operation);
}
if ("getDownloadUrl" in rootStorage) throw new Error("unexpected root storage download capability");
const databaseBinding = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  batch: async (statements) => Promise.all(statements.map((statement) => statement.all())),
};
const database = runtime.d1Database(databaseBinding);
if (typeof runtime.createWorkerSigningHandler !== "function") throw new Error("missing Worker signing handler");
if (database.name !== "d1Database") throw new Error("invalid d1Database name");
if (typeof database.models.analytics.append !== "function") throw new Error("missing analytics model");
if (typeof database.models.apiKeys.create !== "function") throw new Error("missing apiKeys model");
if (typeof database.models.channels.list !== "function") throw new Error("missing channels model");
if ("d1WorkerDatabase" in runtime) throw new Error("unexpected d1WorkerDatabase");
const storage = runtime.r2Storage({
  bucket: {},
  bucketName: "updates",
  downloadUrlSigningKey: "test-signing-key",
});
if (storage.name !== "r2Storage") throw new Error("invalid r2Storage name");
for (const operation of ["put", "get", "getDownloadUrl", "exists", "delete"]) {
  if (typeof storage[operation] !== "function") throw new Error("missing storage " + operation);
}
`;
    await runNode(
      packageDirectory,
      `const rootRuntime = await import(${JSON.stringify(rootSpecifier)});\nconst runtime = await import(${JSON.stringify(moduleSpecifier)});${runtimeAssertions}`,
      true,
    );
    await runNode(
      packageDirectory,
      `const rootRuntime = require(${JSON.stringify(rootSpecifier)});\nconst runtime = require(${JSON.stringify(moduleSpecifier)});${runtimeAssertions}`,
    );

    const moduleConsumer = path.join(packageDirectory, "consumer.mts");
    const commonJsConsumer = path.join(packageDirectory, "consumer.cts");
    const consumerSource = `import { r2Storage as rootStorage, workerSigning } from ${JSON.stringify(
      rootSpecifier,
    )};\nimport { createWorkerSigningHandler, d1Database, r2Storage } from ${JSON.stringify(
      moduleSpecifier,
    )};\ndeclare const binding: Parameters<typeof d1Database>[0];\ndeclare const rootStorageConfig: Parameters<typeof rootStorage>[0];\ndeclare const storageConfig: Parameters<typeof r2Storage>[0];\ntype SigningHandlerOptions = Parameters<typeof createWorkerSigningHandler>[0];\nconst database = d1Database(binding);\nconst nodeStorage = rootStorage(rootStorageConfig);\nconst workerStorage = r2Storage(storageConfig);\nconst signing = workerSigning({ workerUrl: "https://signer.example.com", publicKeyPath: "keys/public.pem" });\nvoid database.models.bundles;\nvoid database.models.bundlePatches;\nvoid database.models.channels;\nvoid database.models.releaseCatalogs;\nvoid database.models.releases;\nvoid database.models.analytics;\nvoid database.models.apiKeys;\nvoid database.commit;\nvoid nodeStorage.put;\nvoid nodeStorage.get;\nvoid nodeStorage.exists;\nvoid nodeStorage.delete;\nvoid workerStorage.put;\nvoid workerStorage.get;\nvoid workerStorage.getDownloadUrl;\nvoid workerStorage.exists;\nvoid workerStorage.delete;\nvoid signing.sign;\nvoid ({} as SigningHandlerOptions).privateKey;\n`;
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
    const signingSpecifier = "@hot-updater/supabase/edge/signing";
    for (const file of ["edgeSigning.cjs", "edgeSigning.mjs"]) {
      const source = await readFile(
        path.join(packageDirectory, "dist", file),
        "utf8",
      );
      expect(source).not.toContain("@supabase/supabase-js");
      expect(source).not.toContain("supabaseStorage");
    }
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
  const storage = runtime.supabaseStorage({ ...config, bucketName: "updates" });
  if (storage.name !== "supabaseStorage") throw new Error("invalid supabaseStorage name");
  for (const operation of ["put", "get", "getDownloadUrl", "exists", "delete"]) {
    if (typeof storage[operation] !== "function") throw new Error("missing storage " + operation);
  }
}
if (typeof rootRuntime.edgeFunctionSigning !== "function") throw new Error("missing root Edge Function signer");
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
    const consumerSource = `import { edgeFunctionSigning, supabaseDatabase as rootDatabase, supabaseStorage as rootStorage } from ${JSON.stringify(
      rootSpecifier,
    )};\nimport { supabaseDatabase as edgeDatabase, supabaseStorage as edgeStorage } from ${JSON.stringify(
      edgeSpecifier,
    )};\nimport { createEdgeFunctionSigningHandler } from ${JSON.stringify(
      signingSpecifier,
    )};\nconst config: Parameters<typeof rootDatabase>[0] = { supabaseUrl: "https://test.supabase.invalid", supabaseServiceRoleKey: "test-service-role-key" };\nconst edgeConfig: Parameters<typeof edgeDatabase>[0] = config;\nconst rootStorageConfig: Parameters<typeof rootStorage>[0] = { ...config, bucketName: "updates" };\nconst edgeStorageConfig: Parameters<typeof edgeStorage>[0] = rootStorageConfig;\ntype SigningHandlerOptions = Parameters<typeof createEdgeFunctionSigningHandler>[0];\nconst signing = edgeFunctionSigning({ functionUrl: "https://project.supabase.co/functions/v1/bundle-signer", publicKeyPath: "keys/public.pem" });\nvoid rootDatabase(config).models.channels;\nvoid edgeDatabase(edgeConfig).models.channels;\nvoid rootStorage(rootStorageConfig).getDownloadUrl;\nvoid edgeStorage(edgeStorageConfig).getDownloadUrl;\nvoid signing.sign;\nvoid ({} as SigningHandlerOptions).privateKey;\n`;
    await writeFile(moduleConsumer, consumerSource);
    await writeFile(commonJsConsumer, consumerSource);
    await typeCheckConsumers(packageDirectory, [
      moduleConsumer,
      commonJsConsumer,
    ]);
  });
});
