import { beforeEach, expect, it, vi } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "./d1Database";
import { createD1TestDatabase } from "./d1TestDatabase";

type Body = {
  readonly sql?: string;
  readonly params?: readonly string[];
  readonly batch?: readonly { sql: string; params: readonly string[] }[];
};

const state = vi.hoisted(() => ({
  database: undefined as ReturnType<typeof createD1TestDatabase> | undefined,
  bodies: [] as Body[],
}));

/** The REST API over `node:sqlite`, recording each request body. */
vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    readonly d1 = {
      database: {
        query: async (_databaseId: string, body: Body) => {
          state.bodies.push(body);
          const result = state.database!.batch(
            body.batch ?? [{ sql: body.sql!, params: body.params ?? [] }],
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

const plugin = () =>
  d1Database({
    accountId: "account-id",
    cloudflareApiToken: "api-token",
    databaseId: "database-id",
  });

beforeEach(() => {
  state.database = createD1TestDatabase();
  state.bodies = [];
});

it("binds every value as JSON text and reads it back with json_extract", async () => {
  const channel = createChannelRowFixture("production");
  await plugin().models.channels.insert({
    row: channel,
    onConflict: "returnExisting",
  });
  await expect(plugin().models.channels.list({})).resolves.toEqual({
    channels: [channel],
  });
  const statements = state.bodies.flatMap(
    (body) => body.batch ?? [{ sql: body.sql!, params: body.params ?? [] }],
  );
  for (const { sql, params } of statements) {
    expect(sql.match(/\?/gu)?.length ?? 0).toBe(
      sql.match(/json_extract\(\?, '\$'\)/gu)?.length ?? 0,
    );
    for (const param of params) expect(() => JSON.parse(param)).not.toThrow();
  }
});

it("sends a write as one batch: the guard row, each guard, the changes, then the failure", async () => {
  const channel = createChannelRowFixture("production");
  const bundle = createBundleRowFixture("1");
  const release = createReleaseRowFixture("1", bundle, channel);
  await plugin().models.channels.insert({
    row: channel,
    onConflict: "returnExisting",
  });
  state.bodies = [];
  await expect(
    plugin().commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        { model: "releases", operation: "insert", row: release },
      ],
    }),
  ).resolves.toEqual({ committed: true });
  const [write] = state.bodies.filter((body) => body.batch !== undefined);
  const sql = write!.batch!.map((statement) => statement.sql);
  expect(sql[0]).toMatch(/^INSERT INTO "_hu_write"/u);
  expect(sql.at(-2)).toMatch(/^SELECT "failed_op" FROM "_hu_write"/u);
  expect(sql.at(-1)).toMatch(/^DELETE FROM "_hu_write"/u);
  await expect(plugin().models.releases.findById(release.id)).resolves.toEqual(
    release,
  );
});

it("applies nothing when a guard fails", async () => {
  const channel = createChannelRowFixture("production");
  const bundle = createBundleRowFixture("1");
  const release = createReleaseRowFixture("1", bundle, channel);
  await plugin().models.channels.insert({
    row: channel,
    onConflict: "returnExisting",
  });
  await plugin().commit({
    changes: [
      { model: "bundles", operation: "insert", row: bundle },
      { model: "releases", operation: "insert", row: release },
    ],
  });
  const next = createBundleRowFixture("2");
  await expect(
    plugin().commit({
      expectations: [{ model: "releases", id: release.id, revision: 7 }],
      changes: [{ model: "bundles", operation: "insert", row: next }],
    }),
  ).resolves.toMatchObject({ committed: false });
  await expect(plugin().models.bundles.findById(next.id)).resolves.toBeNull();
});
