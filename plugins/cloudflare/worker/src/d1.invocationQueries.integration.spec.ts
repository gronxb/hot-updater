import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import { createHotUpdater } from "@hot-updater/server";
import {
  createBundleFixture,
  createReleaseCatalogTestStorage,
  setReleaseCatalogPartitioning,
} from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, inject, it } from "vitest";

import { D1_MAX_OPS } from "../../src/d1Executor";
import { d1Database, type D1Like } from "../../src/worker";

/**
 * D1 counts what a Worker invocation sends to its binding: each prepared
 * statement it runs is one query, and each `batch` is one query however
 * many statements it holds (Cloudflare's D1 limits). This counts both, so
 * a write path's cost is measured in the unit the invocation limit uses.
 */
const countingBinding = (database: D1Database) => {
  const tally = { batches: 0, statements: 0, largestBatch: 0, queries: 0 };
  const binding: D1Like = {
    prepare: (sql) => ({
      bind: (...params) => {
        const statement = database.prepare(sql).bind(...params);
        return Object.assign(
          {
            all: async () => {
              tally.queries += 1;
              tally.statements += 1;
              return statement.all();
            },
          },
          { statement },
        );
      },
    }),
    batch: async (bound) => {
      tally.queries += 1;
      tally.batches += 1;
      tally.statements += bound.length;
      tally.largestBatch = Math.max(tally.largestBatch, bound.length);
      return database.batch(
        bound.map(
          (each) =>
            (each as unknown as { statement: D1PreparedStatement }).statement,
        ),
      );
    },
  };
  const measure = async (work: () => Promise<unknown>) => {
    tally.batches = 0;
    tally.statements = 0;
    tally.largestBatch = 0;
    tally.queries = 0;
    await work();
    return { ...tally };
  };
  return { binding, measure };
};

const PAID_QUERIES_PER_INVOCATION = 1_000;
const FREE_QUERIES_PER_INVOCATION = 50;
const VERSIONS = 300;

const migrate = async () => {
  // `exec` runs one statement per line, and a comment line is not one.
  for (const migration of inject("d1Migrations")) {
    await env.DB.exec(
      migration.sql
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("--"))
        .join("\n"),
    );
  }
};

const release = (channel: string, targetAppVersion: string) => ({
  channel,
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion,
});

const scopeOf = (channel: string) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey(channel),
    platform: "ios",
    strategy: "APP_VERSION",
  });

/** Whether a catalog row is a partitioned scope's head. */
const isHead = (payload: string | undefined) =>
  payload !== undefined && payload.includes('"layout":"partitioned"');

let migrated: Promise<void> | undefined;

/**
 * 300 exact versions, one release each, written compact on `channel`, then
 * the switch on: the next deploy converts the scope. `capped` is the binding
 * as the Worker runs it, declaring the Free plan's 50 queries; uncapped, the
 * same binding without that cap, as Paid's 1,000 measures it.
 */
const scenario = (channel: string, capped: boolean) => {
  const counted = countingBinding(env.DB);
  const binding = d1Database(counted.binding);
  const database = capped
    ? binding
    : {
        ...binding,
        adapter: Object.assign(Object.create(binding.adapter), {
          maxQueriesPerRequest: undefined,
        }),
      };
  const hotUpdater = createHotUpdater({
    database,
    clientAccess: "public",
    storage: createReleaseCatalogTestStorage(),
  });
  const deploy = (suffix: number, targetAppVersion: string) =>
    hotUpdater.core.deploy([
      {
        bundle: createBundleFixture(String(suffix)),
        release: release(channel, targetAppVersion),
      },
    ]);
  const head = async () =>
    isHead(
      (
        await env.DB.prepare(
          "SELECT payload FROM release_catalogs WHERE scope_key = ?",
        )
          .bind(scopeOf(channel))
          .first<{ payload: string }>()
      )?.payload,
    );
  const seed = async (offset: number) => {
    await (migrated ??= migrate());
    for (let version = 1; version <= VERSIONS; version += 1) {
      await deploy(offset + version, `${version}.0.0`);
    }
    await setReleaseCatalogPartitioning(database.adapter, "on");
  };
  return { counted, deploy, head, hotUpdater, seed };
};

describe("D1 binding calls of partitioned catalog writes, uncapped (Paid accounting)", () => {
  const { counted, deploy, head, hotUpdater, seed } = scenario(
    "production",
    false,
  );
  const measured: Record<
    string,
    Awaited<ReturnType<typeof counted.measure>>
  > = {};

  beforeAll(() => seed(0), 600_000);

  it("stages a 300-version conversion in one batch per chunk, under the Paid invocation limit", async () => {
    measured.conversion = await counted.measure(() =>
      deploy(VERSIONS + 1, `${VERSIONS + 1}.0.0`),
    );
    const row = await hotUpdater.core.getReleaseCatalogRow(
      scopeOf("production"),
    );
    expect(row?.generation).toBe(VERSIONS + 1);
    expect(await head()).toBe(true);
    // It staged: no batch carries more ops than one write may.
    expect(measured.conversion.largestBatch).toBeLessThanOrEqual(
      D1_MAX_OPS * 2 + 3,
    );
    expect(measured.conversion.queries).toBeLessThan(
      PAID_QUERIES_PER_INVOCATION,
    );
  });

  it("deploys one exact version afterwards in a few queries", async () => {
    measured.steady = await counted.measure(() =>
      deploy(VERSIONS + 2, `${VERSIONS + 2}.0.0`),
    );
    expect(measured.steady.batches).toBe(1);
    expect(measured.steady.queries).toBeLessThan(FREE_QUERIES_PER_INVOCATION);
  });

  /**
   * A staged write reads the rows it rewrites, and cleanup the rows it
   * deletes, through one batch read each: a query per page, not per row.
   * Before that, a broad release over 603 rows took 696 queries and the
   * next one, whose staging drained the retired epoch, 1,426. Each staged
   * publication now drains what it retired after its flip, in the same
   * invocation: 265 queries each, over a Free plan's 50, which the capped
   * binding below keeps every request under.
   */
  it("stages a broad insert over 603 rows and drains what it retired, under the Paid invocation limit", async () => {
    measured.broad = await counted.measure(() =>
      deploy(VERSIONS + 3, ">=1.0.0"),
    );
    measured.drain = await counted.measure(() =>
      deploy(VERSIONS + 4, ">=2.0.0"),
    );
    expect(await head()).toBe(true);
    expect(measured.broad.queries).toBeLessThanOrEqual(320);
    expect(measured.drain.queries).toBeLessThanOrEqual(320);
  });
});

describe("D1 binding calls of partitioned catalog writes, capped at the Free plan's 50 queries", () => {
  const { counted, deploy, head, seed } = scenario("budget", true);

  beforeAll(() => seed(10_000), 600_000);

  it("never sends a request past its 50 queries: a staged publication that wouldn't fit writes today's compact row", async () => {
    const requests = [
      // The conversion, a steady deploy, then broad inserts over 603 rows.
      () => deploy(10_000 + VERSIONS + 1, `${VERSIONS + 1}.0.0`),
      () => deploy(10_000 + VERSIONS + 2, `${VERSIONS + 2}.0.0`),
      () => deploy(10_000 + VERSIONS + 3, ">=1.0.0"),
      () => deploy(10_000 + VERSIONS + 4, ">=2.0.0"),
      () => deploy(10_000 + VERSIONS + 5, `${VERSIONS + 5}.0.0`),
    ];
    for (const request of requests) {
      const { queries } = await counted.measure(request);
      expect(queries).toBeLessThanOrEqual(FREE_QUERIES_PER_INVOCATION);
    }
    // The broad inserts couldn't stage within 50 queries: the scope is a
    // compact row, as today, and its catalog is complete.
    expect(await head()).toBe(false);
  });
});
