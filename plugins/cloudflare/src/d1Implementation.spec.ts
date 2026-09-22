import { expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createD1Implementation, type D1Statement } from "./d1Implementation";

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

it("persists required manifest fields and patch byte sizes", async () => {
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
    git_commit_hash: null,
    metadata: {},
    manifest_storage_uri: "storage://bundle/manifest.json",
    manifest_file_hash: "manifest-hash",
    asset_base_storage_uri: "storage://assets",
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

  expect(recorded[0]?.sql).toContain("manifest_file_hash");
  expect(recorded[0]?.params).toContain('"manifest-hash"');
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

it("records the event and advances its head in one atomic batch", async () => {
  let statements: readonly D1Statement[] = [];
  const implementation = createD1Implementation({
    query: () => Promise.reject(new Error("unexpected standalone query")),
    async batch(input) {
      statements = input;
      return [];
    },
  });
  const event = createBundleEventRowFixture("1", 100);
  await implementation.recordInsights({ event });
  const [insert, ...remaining] = statements;
  const summaries = remaining.slice(0, -2);
  const head = remaining.at(-2);
  const completed = remaining.at(-1);
  expect(insert?.sql).toContain("INSERT INTO bundle_events");
  expect(insert?.sql).toContain("ON CONFLICT(id) DO NOTHING");
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.every(({ sql }) => sql.includes("insights_overview"))).toBe(
    true,
  );
  expect(head?.sql).toContain("INSERT INTO bundle_event_heads");
  expect(head?.sql).toContain(
    "FROM bundle_events WHERE id = json_extract(?, '$')",
  );
  expect(head?.params).toEqual([JSON.stringify(event.id)]);
  expect(completed?.sql).toContain("SET insights_processed = 1");
  expect(completed?.params).toEqual([JSON.stringify(event.id)]);
});
