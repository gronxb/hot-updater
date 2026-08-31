import { expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createD1Implementation, type D1Statement } from "./d1Implementation";

it("guards every write and reports the missing change index", async () => {
  let recorded: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      recorded = statements;
      return statements.map((_, index) =>
        index === 0 ? [{ id: "bundle-1" }] : [],
      );
    },
  });

  const result = await implementation.commit?.({
    changes: [
      {
        model: "bundles",
        operation: "update",
        where: { id: "bundle-1" },
        update: { metadata: { app_version: "1.0.0" } },
      },
      {
        model: "apiKeys",
        operation: "update",
        where: { id: "missing-key" },
        update: { revokedAtMs: 1 },
      },
    ],
  });

  expect(result).toEqual({
    committed: false,
    conflict: { changeIndex: 1, reason: "not_found" },
  });
  expect(recorded.slice(0, 2).map(({ sql }) => sql)).toEqual([
    "SELECT id FROM bundles WHERE id = json_extract(?, '$') LIMIT 1",
    "SELECT id FROM api_keys WHERE id = json_extract(?, '$') LIMIT 1",
  ]);
  expect(recorded.slice(2)).toHaveLength(2);
  for (const statement of recorded.slice(2)) {
    expect(statement.sql).toContain("SELECT 1 FROM json_each(?) AS required");
    expect(statement.params).toContain(
      JSON.stringify([
        { model: "bundles", id: "bundle-1" },
        { model: "api_keys", id: "missing-key" },
      ]),
    );
  }
});

it("reconciles an atomic commit when its in-batch Release guard fails", async () => {
  let queryCount = 0;
  const implementation = createD1Implementation({
    async query(sql) {
      expect(sql).toContain("SELECT revision FROM releases");
      queryCount += 1;
      return [{ actual_version: 2 }];
    },
    async batch(statements) {
      expect(statements[0]?.sql).toContain(
        "HOT_UPDATER_COMMIT_EXPECTATION_CONFLICT",
      );
      expect(
        statements.some(({ sql }) => sql.includes("UPDATE releases")),
      ).toBe(true);
      throw new Error("D1_ERROR: malformed JSON");
    },
  });

  await expect(
    implementation.commit?.({
      changes: [
        {
          model: "releases",
          operation: "update",
          where: { id: "release-1" },
          update: { revision: 2 },
        },
      ],
      expectations: [{ id: "release-1", model: "releases", revision: 1 }],
    }),
  ).resolves.toEqual({
    committed: false,
    conflict: {
      actualVersion: 2,
      changeIndex: -1,
      expectedVersion: 1,
      key: "release-1",
      model: "releases",
      reason: "version_conflict",
    },
  });
  expect(queryCount).toBe(1);
});

it("maps idempotent Channel inserts to the normalized table", async () => {
  let recorded: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      recorded = statements;
      return statements.map(() => []);
    },
  });

  await expect(
    implementation.commit?.({
      changes: [
        {
          model: "channels",
          operation: "insert",
          row: { id: "candidate", name: "production" },
          onConflict: "ignore",
        },
      ],
    }),
  ).resolves.toEqual({ committed: true });

  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.sql).toContain("INSERT INTO channels (id, name)");
  expect(recorded[0]?.sql).toContain("ON CONFLICT(name) DO NOTHING");
});

it("rejects a 51-statement commit before calling D1 batch", async () => {
  const batchSizes: number[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      batchSizes.push(statements.length);
      return statements.map(() => []);
    },
  });
  const commit = (count: number) =>
    implementation.commit?.({
      changes: Array.from({ length: count }, (_, index) => ({
        model: "channels" as const,
        operation: "insert" as const,
        row: { id: `channel-${index}`, name: `channel-${index}` },
        onConflict: "ignore" as const,
      })),
    });

  await expect(commit(49)).resolves.toEqual({ committed: true });
  await expect(commit(50)).resolves.toEqual({ committed: true });
  await expect(commit(51)).rejects.toThrow();
  expect(batchSizes).toEqual([49, 50]);
});

it("reserves the 50th query for one-shot expectation reconciliation", async () => {
  let invocationQueries = 0;
  const implementation = createD1Implementation({
    async query() {
      invocationQueries += 1;
      return [{ actual_version: 2 }];
    },
    async batch(statements) {
      invocationQueries += statements.length;
      throw new Error("D1_ERROR: malformed JSON");
    },
  });
  const commit = (count: number) =>
    implementation.commit?.({
      changes: Array.from({ length: count }, (_, index) => ({
        model: "channels" as const,
        operation: "insert" as const,
        row: { id: `channel-${index}`, name: `channel-${index}` },
        onConflict: "ignore" as const,
      })),
      expectations: [{ id: "release-1", model: "releases", revision: 1 }],
    });

  await expect(commit(48)).resolves.toMatchObject({
    committed: false,
    conflict: { actualVersion: 2, reason: "version_conflict" },
  });
  expect(invocationQueries).toBe(50);
  await expect(commit(49)).rejects.toThrow();
  expect(invocationQueries).toBe(50);
});

it("packs many commit expectations into one bound JSON parameter", async () => {
  let statements: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected reconciliation")),
    async batch(input) {
      statements = input;
      return input.map((_, index) => (index === 0 ? [{}] : []));
    },
  });
  await expect(
    implementation.commit?.({
      changes: [
        {
          model: "channels",
          operation: "insert",
          row: { id: "channel", name: "channel" },
          onConflict: "ignore",
        },
      ],
      expectations: Array.from({ length: 101 }, (_, index) => ({
        id: `release-${index}`,
        model: "releases" as const,
        revision: null,
      })),
    }),
  ).resolves.toEqual({ committed: true });
  expect(statements).toHaveLength(2);
  expect(statements.every(({ params }) => params.length <= 5)).toBe(true);
  expect(statements[0]?.params).toHaveLength(1);
});

it("returns no raw rows from a mixed batch containing large Insights events", async () => {
  let statements: readonly D1Statement[] = [];
  let returnedRows = 0;
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(input) {
      statements = input;
      const results = input.map(() => [] as readonly unknown[]);
      returnedRows = results.flat().length;
      return results;
    },
  });
  const events = [
    {
      ...createBundleEventRowFixture("951", 100),
      username: "a".repeat(1_100_000),
    },
    {
      ...createBundleEventRowFixture("952", 200),
      username: "b".repeat(1_100_000),
    },
  ];

  await expect(
    implementation.commit?.({
      changes: events.map((row) => ({
        model: "insights" as const,
        operation: "insert" as const,
        row,
      })),
    }),
  ).resolves.toEqual({ committed: true });
  expect(statements).toHaveLength(2);
  expect(statements.every(({ sql }) => !/\bRETURNING\b/i.test(sql))).toBe(true);
  expect(returnedRows).toBe(0);
});

it("persists required archive and patch byte sizes", async () => {
  let recorded: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      recorded = statements;
      return statements.map(() => []);
    },
  });
  const bundle = {
    id: "bundle-1",
    platform: "ios" as const,
    file_hash: "bundle-hash",
    git_commit_hash: null,
    storage_uri: "storage://bundle",
    archive_byte_size: 3_000_000_001,
    metadata: {},
    manifest_storage_uri: null,
    manifest_file_hash: null,
    asset_base_storage_uri: null,
  };

  await expect(
    implementation.commit?.({
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "bundlePatches",
          operation: "insert",
          row: {
            id: "patch-1",
            bundle_id: bundle.id,
            base_bundle_id: bundle.id,
            base_file_hash: "base-hash",
            patch_file_hash: "patch-hash",
            patch_storage_uri: "storage://patch",
            byte_size: 3_000_000_002,
            order_index: 0,
          },
        },
      ],
    }),
  ).resolves.toEqual({ committed: true });

  expect(recorded[0]?.sql).toContain("archive_byte_size");
  expect(recorded[0]?.params).toContain("3000000001");
  expect(recorded[1]?.sql).toContain("byte_size");
  expect(recorded[1]?.params).toContain("3000000002");
});

it("returns the canonical Channel row after a concurrent name conflict", async () => {
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      expect(statements[0]?.sql).toContain("ON CONFLICT(name) DO NOTHING");
      expect(statements[1]?.sql).toBe(
        "SELECT id, name FROM channels WHERE name = json_extract(?, '$') LIMIT 1",
      );
      return [[], [{ id: "canonical", name: "production" }]];
    },
  });

  await expect(
    implementation.insertChannel({
      row: { id: "losing-candidate", name: "production" },
      onConflict: "returnExisting",
    }),
  ).resolves.toEqual({
    row: { id: "canonical", name: "production" },
    inserted: false,
  });
});

it("deletes an empty Channel and distinguishes missing and referenced rows", async () => {
  const results = [
    [[{ id: "empty" }], [], [{ id: "empty" }]],
    [[], [], []],
    [[{ id: "active" }], [{ id: "release" }], []],
  ];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      expect(statements[2]?.sql).toContain(
        "DELETE FROM channels WHERE id = json_extract(?, '$') AND NOT EXISTS",
      );
      return results.shift() ?? [];
    },
  });

  await expect(implementation.deleteChannel({ id: "empty" })).resolves.toEqual({
    deleted: true,
  });
  await expect(
    implementation.deleteChannel({ id: "missing" }),
  ).resolves.toEqual({ deleted: false, reason: "not_found" });
  await expect(implementation.deleteChannel({ id: "active" })).resolves.toEqual(
    { deleted: false, reason: "not_empty" },
  );
});

it("guards a generic Channel delete and reports a referenced conflict", async () => {
  let recorded: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(statements) {
      recorded = statements;
      return [[{ id: "bundle" }], []];
    },
  });

  await expect(
    implementation.commit?.({
      changes: [
        {
          model: "channels",
          operation: "delete",
          where: { id: "active" },
        },
      ],
    }),
  ).resolves.toEqual({
    committed: false,
    conflict: { changeIndex: 0, reason: "referenced" },
  });
  expect(recorded[1]?.sql).toContain("DELETE FROM channels");
  expect(recorded[1]?.sql).toContain("NOT EXISTS");
});
