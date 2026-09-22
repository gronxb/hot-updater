import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import type {
  BundleRow,
  DatabasePlugin,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getPlatformProxy } from "wrangler";

import { d1Database as httpDatabase } from "./d1Database";
import { createD1Implementation, type D1Statement } from "./d1Implementation";
import { d1Database } from "./worker/d1Database";

const transport = vi.hoisted(() => ({
  execute: undefined as
    | ((statements: readonly D1Statement[]) => Promise<readonly D1Result[]>)
    | undefined,
}));
vi.mock("cloudflare", () => ({
  default: class {
    d1 = {
      database: {
        query: async (
          _id: string,
          input: D1Statement | { batch: readonly D1Statement[] },
        ) => {
          const result = await transport.execute!(
            "batch" in input ? input.batch : [input],
          );
          return {
            async *iterPages() {
              yield { result };
            },
          };
        },
      },
    };
  },
}));

const bundle: BundleRow = {
  id: "bundle-1",
  platform: "ios",
  git_commit_hash: null,
  metadata: {},
  manifest_storage_uri: "storage://bundle-1/manifest.json",
  manifest_file_hash: "hash",
  asset_base_storage_uri: "storage://assets",
};
const release: ReleaseRow = {
  id: "00000000-0000-7000-8000-000000000001",
  revision: 1,
  scope_key: "v1:app-version:ios:cHJvZHVjdGlvbg",
  channel_id: "channel-1",
  platform: "ios",
  kind: "BUNDLE",
  bundle_id: bundle.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 0,
  updated_at_ms: 0,
};

describe.each(["worker", "http"] as const)(
  "D1 %s ordered atomic commits",
  (mode) => {
    let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
    let plugin: DatabasePlugin;
    const execute = vi.fn(async (statements: readonly D1Statement[]) =>
      proxy.env.DB.batch(
        statements.map(({ sql, params }) =>
          proxy.env.DB.prepare(sql).bind(...params),
        ),
      ),
    );

    beforeAll(async () => {
      proxy = await getPlatformProxy<{ DB: D1Database }>({
        configPath: fileURLToPath(
          new URL("../worker/wrangler.test.json", import.meta.url),
        ),
        persist: false,
        remoteBindings: false,
      });
      const schema = await readFile(
        new URL("../sql/bundles.sql", import.meta.url),
        "utf8",
      );
      await proxy.env.DB.prepare(schema).run();
      transport.execute = execute;
      plugin =
        mode === "worker"
          ? d1Database(proxy.env.DB)
          : httpDatabase({
              accountId: "account",
              databaseId: "database",
              cloudflareApiToken: "test",
            });
    });
    afterAll(async () => {
      await proxy?.dispose();
    });
    beforeEach(async () => {
      await proxy.env.DB.prepare(
        "DELETE FROM release_catalogs; DELETE FROM releases; DELETE FROM bundles; DELETE FROM channels; DELETE FROM api_keys;",
      ).run();
      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row: bundle }],
      });
      execute.mockClear();
    });

    it("rolls back delete followed by update of the same bundle", async () => {
      await expect(
        plugin.commit({
          changes: [
            { model: "bundles", operation: "delete", where: { id: bundle.id } },
            {
              model: "bundles",
              operation: "update",
              where: { id: bundle.id },
              update: { git_commit_hash: "next" },
            },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "not_found" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
    });

    it("rolls back insert/delete/update including unrelated earlier changes", async () => {
      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: { id: "channel-1", name: "production" },
              onConflict: "ignore",
            },
            {
              model: "bundles",
              operation: "insert",
              row: { ...bundle, id: "new" },
            },
            { model: "bundles", operation: "delete", where: { id: "new" } },
            {
              model: "bundles",
              operation: "update",
              where: { id: "new" },
              update: {},
            },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 3, reason: "not_found" },
      });
      await expect(plugin.models.bundles.findById("new")).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("executes later changes after a successful update/delete", async () => {
      await expect(
        plugin.commit({
          changes: [
            {
              model: "bundles",
              operation: "update",
              where: { id: bundle.id },
              update: { git_commit_hash: "next" },
            },
            { model: "bundles", operation: "delete", where: { id: bundle.id } },
            {
              model: "channels",
              operation: "insert",
              row: { id: "channel-1", name: "production" },
              onConflict: "ignore",
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [{ id: "channel-1", name: "production" }],
      });
    });

    it("checks expectations even when the commit contains no changes", async () => {
      await expect(
        plugin.commit({
          changes: [],
          expectations: [{ model: "releases", id: release.id, revision: 1 }],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: {
          actualVersion: null,
          expectedVersion: 1,
          changeIndex: -1,
          key: release.id,
          model: "releases",
          reason: "version_conflict",
        },
      });
    });

    it("allows an empty commit whose absence expectation holds", async () => {
      await expect(
        plugin.commit({
          changes: [],
          expectations: [{ model: "releases", id: release.id, revision: null }],
        }),
      ).resolves.toEqual({ committed: true });
    });

    it("returns an indexed conflict for a referenced bundle without deleting it", async () => {
      await plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: "channel-1", name: "production" },
            onConflict: "ignore",
          },
          { model: "releases", operation: "insert", row: release },
        ],
      });
      await expect(
        plugin.commit({
          changes: [
            { model: "bundles", operation: "delete", where: { id: bundle.id } },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 0, reason: "referenced" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
    });

    it("evaluates references in order and rolls back a newly referenced channel", async () => {
      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: { id: "channel-1", name: "production" },
              onConflict: "ignore",
            },
            { model: "releases", operation: "insert", row: release },
            {
              model: "channels",
              operation: "delete",
              where: { id: "channel-1" },
            },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 2, reason: "referenced" },
      });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toBeNull();
    });

    it("allows deleting references before deleting their channel and bundle", async () => {
      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: { id: "channel-1", name: "production" },
              onConflict: "ignore",
            },
            { model: "releases", operation: "insert", row: release },
            {
              model: "releases",
              operation: "delete",
              where: { id: release.id },
            },
            {
              model: "channels",
              operation: "delete",
              where: { id: "channel-1" },
            },
            { model: "bundles", operation: "delete", where: { id: bundle.id } },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(bundle.id),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("rejects release platform mismatch and rolls back earlier changes", async () => {
      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: { id: "channel-1", name: "production" },
              onConflict: "ignore",
            },
            {
              model: "releases",
              operation: "insert",
              row: { ...release, platform: "android" },
            },
          ],
        }),
      ).rejects.toEqual(new DatabasePluginInputError("invalid-data"));
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("checks versions in one native batch without client snapshot reads", async () => {
      await plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: "channel-1", name: "production" },
            onConflict: "ignore",
          },
          { model: "releases", operation: "insert", row: release },
        ],
      });
      execute.mockClear();
      await expect(
        plugin.commit({
          expectations: [{ model: "releases", id: release.id, revision: 1 }],
          changes: [
            {
              model: "releases",
              operation: "update",
              where: { id: release.id },
              update: { revision: 2 },
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      if (mode === "http") {
        expect(execute).toHaveBeenCalledTimes(1);
        expect(
          execute.mock.calls[0]![0].every(
            ({ sql }) => !sql.includes("RETURNING *"),
          ),
        ).toBe(true);
      }
      await expect(
        plugin.commit({
          expectations: [{ model: "releases", id: release.id, revision: 1 }],
          changes: [
            {
              model: "bundles",
              operation: "update",
              where: { id: bundle.id },
              update: { git_commit_hash: "bad" },
            },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: {
          actualVersion: 2,
          expectedVersion: 1,
          changeIndex: -1,
          key: release.id,
          model: "releases",
          reason: "version_conflict",
        },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
    });

    it("reports REAL catalog generations from the failed atomic check", async () => {
      await proxy.env.DB.prepare(
        "INSERT INTO channels (id, name) VALUES ('channel-1', 'production'); INSERT INTO release_catalogs (scope_key, catalog_id, strategy, channel_id, channel_key, platform, fingerprint_hash, generation, payload, catalog_hash, byte_size, is_tombstone, updated_at_ms) VALUES ('scope', 'catalog', 'APP_VERSION', 'channel-1', 'production', 'ios', NULL, 2, '{}', 'hash', 2, 0, 0);",
      ).run();
      await expect(
        plugin.commit({
          changes: [],
          expectations: [
            { model: "releases", id: release.id, revision: null },
            { model: "releaseCatalogs", scopeKey: "scope", generation: 1 },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: {
          actualVersion: 2,
          expectedVersion: 1,
          changeIndex: -1,
          key: "scope",
          model: "releaseCatalogs",
          reason: "version_conflict",
        },
      });
    });
  },
);

it("keeps an empty commit without expectations free of I/O", async () => {
  const executor = { query: vi.fn(), batch: vi.fn() };
  await expect(
    createD1Implementation(executor).commit!({ changes: [] }),
  ).resolves.toEqual({ committed: true });
  expect(executor.query).not.toHaveBeenCalled();
  expect(executor.batch).not.toHaveBeenCalled();
});

it("does not misclassify unrelated malformed JSON as a version conflict", async () => {
  const error = new Error("D1_ERROR: malformed JSON");
  const executor = { query: vi.fn(), batch: vi.fn().mockRejectedValue(error) };
  await expect(
    createD1Implementation(executor).commit!({
      changes: [],
      expectations: [{ model: "releases", id: release.id, revision: null }],
    }),
  ).rejects.toBe(error);
  expect(executor.query).not.toHaveBeenCalled();
});
