import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const exec = promisify(execFile);
const packageDirectory = path.resolve(import.meta.dirname, "..");

// These are deliberately broken providers: a storage adapter, the Insights
// model, or the served answers. Each must fail its behavioral scenario, not
// merely fail to import or initialize the suite.
const mutations = [
  {
    name: "ignore-lower-bound",
    scenario: "pages all scoped Releases including disabled rows",
    implementation:
      "adapter.query = (table, request) => original.query(table, { ...request, lower: undefined });",
  },
  {
    name: "ignore-upper-bound",
    scenario: "pages each release filter set by key",
    implementation:
      "adapter.query = (table, request) => original.query(table, { ...request, upper: undefined });",
  },
  {
    name: "reverse-order",
    scenario: "pages Catalogs in scope order",
    implementation:
      'adapter.query = (table, request) => original.query(table, { ...request, order: request.order === "asc" ? "desc" : "asc" });',
  },
  {
    name: "short-pages",
    scenario:
      "serves the newest Release among 200 distinct compatible version ranges",
    implementation:
      "adapter.query = (table, request) => original.query(table, { ...request, limit: Math.min(request.limit, 2) });",
  },
  {
    name: "drop-deletes",
    scenario: "hard deletes a Release, rebuilds its Catalog",
    implementation:
      'adapter.write = ops => original.write(ops.filter(op => op.type !== "delete"));',
  },
  {
    name: "ignore-insights-cursor",
    scenario: "uses exact identity and UTF-8 cursor order",
    implementation:
      'const model = insightsModel; insightsModel = database => { const m = model(database); return { ...m, findLatestEvents: input => m.findLatestEvents("userId" in input ? { ...input, afterInstallId: undefined } : input) }; };',
  },
  {
    name: "oldest-ota-first",
    scenario: "rolls a deleted active Release back to older OTA bytes",
    implementation: "",
    responseMutation: "if (body.releases) body.releases.reverse();",
  },
  {
    name: "missing-rollback-candidates",
    scenario:
      "re-evaluates cohort changes and rolls back even when the predecessor rollout is closed",
    implementation: "",
    responseMutation: "if (body.rollbackReleases) body.rollbackReleases = [];",
  },
  {
    name: "wrong-ota-artifact",
    scenario: "runs built-in → OTA A → OTA B → rollback A → built-in",
    implementation: "",
    responseMutation:
      'if (body.manifestFileHash) body.manifestFileHash = "wrong-manifest-hash";',
  },
] as const;

it("rejects broken providers while the unmodified provider passes the public suite", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-contract-mutants-"),
  );
  try {
    await mkdir(path.join(directory, "node_modules/@hot-updater"), {
      recursive: true,
    });
    for (const name of ["server", "test-utils"]) {
      await symlink(
        path.resolve(packageDirectory, "..", name),
        path.join(directory, "node_modules/@hot-updater", name),
        "dir",
      );
    }
    const variants = [
      { name: "control", scenario: undefined, implementation: "" },
      ...mutations,
    ];
    for (const variant of variants) {
      await writeFile(
        path.join(directory, `${variant.name}.spec.ts`),
        `
        import { createHotUpdater } from "@hot-updater/server";
        import { createMemoryAdapter } from "@hot-updater/server/database";
        import { createDatabasePluginApis } from "@hot-updater/server/db";
        import { createInsightsModel, insights } from "@hot-updater/server/plugins/insights";
        import { setupDatabaseTestSuite, startHttpTestServer } from "@hot-updater/test-utils";
        // An empty memory adapter per test, behind one adapter a mutant may break.
        let original = createMemoryAdapter();
        const adapter = {
          id: "memory",
          fits: ops => original.fits(ops),
          get: (table, keys) => original.get(table, keys),
          query: (table, request) => original.query(table, request),
          write: ops => original.write(ops),
        };
        let insightsModel = database =>
          createInsightsModel(createDatabasePluginApis(database, [insights()]).insights);
        ${variant.implementation}
        setupDatabaseTestSuite({
          name: ${JSON.stringify(variant.name)},
          createDatabase: () => ({ name: "memory", adapter }),
          migrate: () => undefined,
          reset: () => { original = createMemoryAdapter(); },
          dispose: () => undefined,
          createInsightsModel: database => insightsModel(database),
          createHttpClient: options => {
            const handlers = createHotUpdater({
              ...options, plugins: [insights()], clientAccess: "public",
            }).handlers;
            return startHttpTestServer({
              ...handlers,
              client: async request => {
                const response = await handlers.client(request);
                if (response.status !== 200) return response;
                const body = await response.json();
                ${"responseMutation" in variant ? variant.responseMutation : ""}
                return new Response(JSON.stringify(body), {
                  status: response.status, headers: response.headers,
                });
              },
            });
          },
        });
      `,
      );
    }
    await writeFile(
      path.join(directory, "vitest.config.mts"),
      `export default ${JSON.stringify({
        test: {
          maxWorkers: 4,
          projects: variants.map((variant) => ({
            test: {
              name: variant.name,
              root: directory,
              include: [`${variant.name}.spec.ts`],
              testNamePattern: variant.scenario,
              testTimeout: 20000,
              hookTimeout: 20000,
            },
          })),
        },
      })};`,
    );
    const { code } = await exec(
      process.execPath,
      [
        path.resolve(packageDirectory, "../../node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        path.join(directory, "vitest.config.mts"),
        "--reporter=json",
        "--outputFile=results.json",
      ],
      { cwd: directory, timeout: 300000 },
    ).then(
      () => ({ code: 0 }),
      (error: { code: number }) => ({ code: error.code }),
    );
    expect(code).toBe(1);
    const result = JSON.parse(
      await readFile(path.join(directory, "results.json"), "utf8"),
    ) as {
      testResults: {
        name: string;
        assertionResults: { title: string; status: string }[];
      }[];
    };
    expect(result.testResults).toHaveLength(variants.length);
    const control = result.testResults.find(
      (test) => path.basename(test.name) === "control.spec.ts",
    )!;
    expect(control.assertionResults.length).toBeGreaterThan(0);
    expect(
      control.assertionResults.every((test) => test.status === "passed"),
    ).toBe(true);
    for (const mutation of mutations) {
      const run = result.testResults.find(
        (test) => path.basename(test.name) === `${mutation.name}.spec.ts`,
      )!;
      const detected = run.assertionResults.some(
        (test) =>
          test.status === "failed" && test.title.includes(mutation.scenario),
      );
      expect(detected, `${mutation.name} must fail: ${mutation.scenario}`).toBe(
        true,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 360000);
