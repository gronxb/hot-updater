import { execFile } from "node:child_process";
import {
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

import { expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

const exec = promisify(execFile);
const packageDirectory = path.resolve(import.meta.dirname, "..");

it("runs the complete contract from the published test-utils package", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-provider-contract-"),
  );
  try {
    await exec("pnpm", ["pack", "--pack-destination", directory], {
      cwd: path.resolve(packageDirectory, "../test-utils"),
    });
    const archive = (await readdir(directory)).find((file) =>
      file.endsWith(".tgz"),
    )!;
    const installed = path.join(
      directory,
      "node_modules/@hot-updater/test-utils",
    );
    await mkdir(installed, { recursive: true });
    await exec("tar", [
      "-xzf",
      path.join(directory, archive),
      "--strip-components=1",
      "-C",
      installed,
    ]);

    // The consumer uses the packed test-utils files and public dependencies only.
    for (const dependency of [
      ...Object.keys(packageJson.dependencies),
      "vitest",
      "execa",
      "@hot-updater/server",
      "@types/node",
      "@electric-sql/pglite",
      "kysely",
      "kysely-pglite-dialect",
    ]) {
      const target = path.join(directory, "node_modules", dependency);
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(
        dependency === "@hot-updater/server"
          ? packageDirectory
          : dependency === "vitest"
            ? path.resolve(packageDirectory, "../../node_modules/vitest")
            : path.join(packageDirectory, "node_modules", dependency),
        target,
        "dir",
      );
    }
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      path.join(directory, "vitest.config.ts"),
      `
      import { defineConfig } from "vitest/config";
      export default defineConfig({ test: { testTimeout: 20000, hookTimeout: 20000 } });
    `,
    );
    await writeFile(
      path.join(directory, "provider.spec.ts"),
      `
      import { PGlite } from "@electric-sql/pglite";
      import { Kysely } from "kysely";
      import { PGliteDialect } from "kysely-pglite-dialect";
      import { createHotUpdater } from "@hot-updater/server";
      import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
      import { createMigrator } from "@hot-updater/server/db";
      import { setupDatabasePluginTestSuite, startHttpTestServer } from "@hot-updater/test-utils";

      const db = new PGlite();
      const kysely = new Kysely({ dialect: new PGliteDialect(db) });
      const plugin = kyselyAdapter({ db: kysely, provider: "postgresql" });
      setupDatabasePluginTestSuite({
        name: "external provider",
        createHttpClient: (options) => startHttpTestServer(createHotUpdater({
          ...options, clientAccess: { type: "public" },
        }).handlers),
        createPlugin: () => plugin,
        migrate: async () => {
          const migration = await createMigrator(createHotUpdater({
            database: plugin, clientAccess: { type: "public" },
          })).migrateToLatest({ mode: "from-schema", updateSettings: true });
          await migration.execute();
        },
        reset: async () => {
          const { rows } = await db.query<{ tablename: string }>(
            "select tablename from pg_tables where schemaname = 'public' and tablename <> 'private_hot_updater_settings'",
          );
          await db.exec('TRUNCATE ' + rows.map(({ tablename }) => '"' + tablename + '"').join(', ') + ' CASCADE');
        },
        dispose: async () => { await kysely.destroy(); await db.close(); },
      });
    `,
    );

    // Importing production and fixture entries must work outside a Vitest run.
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { createHotUpdater } from "@hot-updater/server";
      import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils/node";
      if (typeof createHotUpdater !== "function" || createReleaseCatalogTestStorage().protocol !== "storage") process.exit(1);
    `,
      ],
      { cwd: directory },
    );

    await exec(
      process.execPath,
      [
        path.join(directory, "node_modules/vitest/vitest.mjs"),
        "run",
        "--reporter=json",
        "--outputFile=results.json",
      ],
      { cwd: directory, timeout: 120000 },
    );
    const result = JSON.parse(
      await readFile(path.join(directory, "results.json"), "utf8"),
    );
    expect(result.success).toBe(true);
    expect(result.numTotalTests).toBeGreaterThan(0);
    expect(result.numPassedTests).toBe(result.numTotalTests);
    expect(result.numPendingTests).toBe(0);

    await exec(
      process.execPath,
      [
        path.resolve(
          packageDirectory,
          "../../node_modules/typescript/bin/tsc6",
        ),
        "--noEmit",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--strict",
        "--skipLibCheck",
        "provider.spec.ts",
      ],
      { cwd: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
