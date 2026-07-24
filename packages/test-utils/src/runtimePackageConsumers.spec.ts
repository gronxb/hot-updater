import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  cleanupPackedPackages,
  execFileAsync,
  packProvider,
  readCommandOutput,
  runNode,
  workspaceRoot,
} from "./runtimePackageConsumers.testFixtures";

afterAll(cleanupPackedPackages);

describe("packed runtime provider entrypoints", () => {
  it.each([
    {
      directory: "aws",
      packageName: "@hot-updater/aws/lambda",
      exports: ["s3Database", "s3Storage"],
      handler: "@hot-updater/aws/lambda/handler",
    },
    {
      directory: "firebase",
      packageName: "@hot-updater/firebase/functions",
      exports: ["firebaseDatabase", "firebaseStorage"],
      handler: "@hot-updater/firebase/functions/handler",
    },
    {
      directory: "supabase",
      packageName: "@hot-updater/supabase/edge",
      exports: ["supabaseDatabase", "supabaseStorage"],
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

  it("keeps the packed Cloudflare Worker entrypoint ESM-only", async () => {
    const { packageDirectory } = await packProvider("cloudflare");
    const moduleSpecifier = "@hot-updater/cloudflare/worker";

    const { stdout } = await runNode(
      packageDirectory,
      `process.stdout.write(import.meta.resolve(${JSON.stringify(moduleSpecifier)}));`,
      true,
    );
    expect(stdout).toMatch(/[/\\]dist[/\\]worker[/\\]index\.mjs$/);

    await expect(
      runNode(
        packageDirectory,
        `require.resolve(${JSON.stringify(moduleSpecifier)});`,
      ),
    ).rejects.toMatchObject({ code: 1 });

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
      "tsc",
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

    let commonJsError: unknown;
    try {
      await execFileAsync(
        process.execPath,
        [...compilerArguments, commonJsConsumer],
        { cwd: packageDirectory },
      );
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      commonJsError = error;
    }

    expect(commonJsError).toBeDefined();
    expect(readCommandOutput(commonJsError)).toContain(moduleSpecifier);
  });

  it("composes a packed provider carrier with the server in ESM and CommonJS", async () => {
    const { packageDirectory } = await packProvider("supabase");
    const createRuntime = `
const database = provider.supabaseDatabase({
  supabaseServiceRoleKey: "service-role-key",
  supabaseUrl: "https://example.supabase.co",
});
const runtime = server.createHotUpdater({
  database,
  plugins: [analytics.analytics({
    missingCapability: "error",
    queryAccess: "public",
  })],
});
if (runtime.features.analytics.status !== "available") {
  throw new Error("packed Analytics provider was not composed");
}`;

    await runNode(
      packageDirectory,
      `const provider = await import("@hot-updater/supabase/edge");
const analytics = await import("@hot-updater/analytics");
const server = await import("@hot-updater/server");
${createRuntime}`,
      true,
    );
    await runNode(
      packageDirectory,
      `const provider = require("@hot-updater/supabase/edge");
const analytics = require("@hot-updater/analytics");
const server = require("@hot-updater/server");
${createRuntime}`,
    );
  });

  it("composes a CJS config provider with the ESM Analytics manifest", async () => {
    const { packageDirectory } = await packProvider("supabase");
    await writeFile(
      path.join(packageDirectory, "hot-updater.config.cjs"),
      `const { supabaseDatabase } = require("@hot-updater/supabase/edge");
module.exports = {
  database: supabaseDatabase({
    supabaseServiceRoleKey: "service-role-key",
    supabaseUrl: "https://example.supabase.co",
  }),
};
`,
    );

    await runNode(
      packageDirectory,
      `const { loadConfig } = await import("@hot-updater/cli-tools");
const analytics = await import("@hot-updater/analytics");
const server = await import("@hot-updater/server");
const config = await loadConfig(null);
const runtime = server.createHotUpdater({
  database: config.database,
  plugins: [analytics.analytics({
    missingCapability: "error",
    queryAccess: "public",
  })],
});
if (runtime.features.analytics.status !== "available") {
  throw new Error("mixed-condition Analytics provider was not composed");
}`,
      true,
    );
  });
});
