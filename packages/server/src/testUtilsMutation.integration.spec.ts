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

// These are deliberately broken public plugin implementations. Each must fail
// its behavioral scenario, not merely fail to import or initialize the suite.
const mutations = [
  {
    name: "ignore-insights-cursor",
    scenario: "uses exact identity and UTF-8 cursor order",
    implementation:
      'plugin.models.insights.findLatestEvents = input => original.models.insights.findLatestEvents("userId" in input ? {...input, afterInstallId: undefined} : input);',
  },
  {
    name: "unknown-api-key-fallback",
    scenario: "creates, lists, resolves, and revokes API keys",
    implementation:
      "plugin.models.apiKeys.findByHash = async hash => (await original.models.apiKeys.findByHash(hash)) ?? (await original.models.apiKeys.list())[0] ?? null;",
  },
  {
    name: "ignore-releases-expectations",
    scenario: "rejects a stale releases expectation",
    implementation:
      'plugin.commit = input => original.commit({...input, ...(input.expectations ? {expectations: input.expectations.filter(e => e.model !== "releases")} : {})});',
  },
  {
    name: "ignore-releaseCatalogs-expectations",
    scenario: "rejects a stale releaseCatalogs expectation",
    implementation:
      'plugin.commit = input => original.commit({...input, ...(input.expectations ? {expectations: input.expectations.filter(e => e.model !== "releaseCatalogs")} : {})});',
  },
  {
    name: "ignore-absence-expectations",
    scenario: "rejects a absent",
    implementation:
      'plugin.commit = input => original.commit({...input, ...(input.expectations ? {expectations: input.expectations.filter(e => (e.model === "releases" ? e.revision : e.generation) !== null)} : {})});',
  },
  {
    name: "ignore-missing-row-expectations",
    scenario: "rejects a missing",
    implementation: `plugin.commit = async input => {
const expectations = [];
for (const e of input.expectations ?? []) {
const row = e.model === "releases" ? await original.models.releases.findById(e.id) : await original.models.releaseCatalogs.findByScopeKey(e.scopeKey);
if (row) expectations.push(e);
} return original.commit({...input, expectations}); };`,
  },
  {
    name: "non-atomic-expectation-check",
    scenario: "allows only one concurrent writer",
    implementation: `const pendingWriters = new Map();
plugin.commit = async input => {
for (const e of input.expectations ?? []) {
const row = e.model === "releases" ? await original.models.releases.findById(e.id) : await original.models.releaseCatalogs.findByScopeKey(e.scopeKey);
const expectedVersion = e.model === "releases" ? e.revision : e.generation;
const actualVersion = row === null ? null : e.model === "releases" ? row.revision : row.generation;
if (expectedVersion !== actualVersion) return { committed: false, conflict: {changeIndex: -1, reason: "version_conflict", model:e.model, key:e.id ?? e.scopeKey, expectedVersion, actualVersion} };
} if (input.changes.some(change => change.model === "releases" && change.operation === "update")) {
const key = JSON.stringify(input.expectations);
const pending = pendingWriters.get(key);
if (pending) { pendingWriters.delete(key); pending(); }
else await new Promise(resolve => pendingWriters.set(key, resolve));
}
return original.commit({changes:input.changes}); };`,
  },
  {
    name: "ignore-releases-delete",
    scenario: "rolls a deleted active Release back to older OTA bytes",
    implementation:
      'plugin.commit = input => original.commit({...input, changes:input.changes.filter(c => c.model !== "releases" || c.operation !== "delete")});',
  },
  {
    name: "ignore-bundlePatches-delete",
    scenario: "hydrates multiple owners",
    implementation:
      'plugin.commit = input => original.commit({...input, changes:input.changes.filter(c => c.model !== "bundlePatches" || c.operation !== "delete")});',
  },
  {
    name: "ignore-release-channelId",
    scenario: "applies the channelId filter",
    implementation:
      "plugin.models.releases.findMany = input => original.models.releases.findMany({...input, channelId:undefined});",
  },
  {
    name: "ignore-release-enabled",
    scenario: "applies the enabled filter",
    implementation:
      "plugin.models.releases.findMany = input => original.models.releases.findMany({...input, enabled:undefined});",
  },
  {
    name: "ignore-release-platform",
    scenario: "applies the platform filter",
    implementation:
      "plugin.models.releases.findMany = input => original.models.releases.findMany({...input, platform:undefined});",
  },
  {
    name: "ignore-release-bundleId",
    scenario: "applies the bundleId filter",
    implementation:
      "plugin.models.releases.findMany = input => original.models.releases.findMany({...input, bundleId:undefined});",
  },
  {
    name: "ignore-release-beforeReleaseId",
    scenario: "applies the channelId filter",
    implementation:
      "plugin.models.releases.findMany = input => original.models.releases.findMany({...input, beforeReleaseId:undefined});",
  },
  {
    name: "ignore-release-limit",
    scenario: "applies the channelId filter",
    implementation:
      "plugin.models.releases.findMany = input => original.models.releases.findMany({...input, limit:1000});",
  },
  {
    name: "omit-disabled-from-scope",
    scenario: "pages all scoped Releases",
    implementation:
      "plugin.models.releases.findManyByScope = async input => (await original.models.releases.findManyByScope(input)).filter(r => r.enabled);",
  },
  {
    name: "ignore-catalog-afterScopeKey",
    scenario: "pages Catalogs in scope order",
    implementation:
      "plugin.models.releaseCatalogs.findMany = input => original.models.releaseCatalogs.findMany({...input, afterScopeKey:undefined});",
  },
  {
    name: "ignore-catalog-limit",
    scenario: "pages Catalogs in scope order",
    implementation:
      "plugin.models.releaseCatalogs.findMany = input => original.models.releaseCatalogs.findMany({...input, limit:1000});",
  },
  {
    name: "patch-first-bundle-only",
    scenario: "hydrates multiple owners",
    implementation:
      "plugin.models.bundlePatches.findByBundleIds = ids => original.models.bundlePatches.findByBundleIds(ids.slice(0,1));",
  },
  {
    name: "ignore-null-bundle-updates",
    scenario: "updates nullable and structured artifact fields",
    implementation:
      'plugin.commit = input => original.commit({...input, changes:input.changes.map(c => c.model === "bundles" && c.operation === "update" ? {...c, update:Object.fromEntries(Object.entries(c.update).filter(([,v])=>v!==null))} : c)});',
  },
  {
    name: "bundle-always-ascending",
    scenario: "orders descending before applying offset",
    implementation:
      'plugin.models.bundles.findMany = input => original.models.bundles.findMany({...input,orderBy:{...input.orderBy,direction:"asc"}});',
  },
  {
    name: "non-atomic-commit",
    scenario: "rejects missing owner and base bundle references atomically",
    implementation:
      "plugin.commit = async input => { for (const change of input.changes) { const result = await original.commit({...input,changes:[change]}); if (!result.committed) return result; } return {committed:true}; };",
  },
  {
    name: "drop-embedded-releases",
    scenario: "keeps legacy embedded rows readable",
    implementation:
      'plugin.models.releases.findManyByScope = async input => (await original.models.releases.findManyByScope(input)).filter(r => r.kind !== "EMBEDDED");',
  },
  {
    name: "ignore-release-disable",
    scenario: "runs built-in → OTA A → OTA B → rollback A → built-in",
    implementation:
      'plugin.commit = input => original.commit({...input, changes:input.changes.map(c => c.model === "releases" && c.operation === "update" && c.update.enabled === false ? {...c, update:{...c.update, enabled:true}} : c)});',
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
    responseMutation: 'if (body.fileHash) body.fileHash = "wrong-bundle-hash";',
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
        import { setupDatabasePluginTestSuite, startHttpTestServer } from "@hot-updater/test-utils";
        import { createInMemoryDatabaseHarness } from ${JSON.stringify(path.resolve(packageDirectory, "../test-utils/test/inMemoryDatabasePlugin.ts"))};
        const harness = createInMemoryDatabaseHarness();
        const original = harness.plugin;
        const plugin = { ...original, models: Object.fromEntries(
          Object.entries(original.models).map(([key, model]) => [key, {...model}]),
        ) };
        ${variant.implementation}
        setupDatabasePluginTestSuite({
          name: ${JSON.stringify(variant.name)},
          createPlugin: () => plugin,
          migrate: () => undefined,
          reset: () => harness.reset(),
          dispose: () => undefined,
          createHttpClient: options => {
            const handlers = createHotUpdater({
              ...options, clientAccess: { type: "public" },
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
      { cwd: directory, timeout: 120000 },
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
}, 150000);
