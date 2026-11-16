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

const release = (targetAppVersion: string) => ({
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion,
});

describe("D1 binding calls of partitioned catalog writes (workerd)", () => {
  const counted = countingBinding(env.DB);
  const database = d1Database(counted.binding);
  const hotUpdater = createHotUpdater({
    database,
    clientAccess: "public",
    storage: createReleaseCatalogTestStorage(),
  });
  const deploy = (suffix: number, targetAppVersion: string) =>
    hotUpdater.core.deploy([
      {
        bundle: createBundleFixture(String(suffix)),
        release: release(targetAppVersion),
      },
    ]);
  const measured: Record<
    string,
    Awaited<ReturnType<typeof counted.measure>>
  > = {};

  beforeAll(async () => {
    await migrate();
    // 300 exact versions, one release each, written compact.
    for (let version = 1; version <= VERSIONS; version += 1) {
      await deploy(version, `${version}.0.0`);
    }
    await setReleaseCatalogPartitioning(database.adapter, "on");
  }, 600_000);

  it("stages a 300-version conversion in one batch per chunk, under the Paid invocation limit", async () => {
    measured.conversion = await counted.measure(() =>
      deploy(VERSIONS + 1, `${VERSIONS + 1}.0.0`),
    );
    const row = await hotUpdater.core.getReleaseCatalogRow(
      createReleaseCatalogScopeKey({
        channelKey: encodeChannelKey("production"),
        platform: "ios",
        strategy: "APP_VERSION",
      }),
    );
    expect(row?.generation).toBe(VERSIONS + 1);
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
   * next one, whose staging drained the retired epoch, 1,426. Now each
   * staged publication drains what it retired after its flip, in the same
   * invocation: 265 queries each. Both stay over a Free plan's 50.
   */
  it("drains a retired 600-row epoch inside a later staged publication, under the Paid invocation limit", async () => {
    // A broad release rewrites every row: staged, it retires the epoch.
    measured.broad = await counted.measure(() =>
      deploy(VERSIONS + 3, ">=1.0.0"),
    );
    // The next staged publication registers, drains that epoch, then stages.
    measured.drain = await counted.measure(() =>
      deploy(VERSIONS + 4, ">=2.0.0"),
    );
    expect(measured.broad.queries).toBeLessThan(PAID_QUERIES_PER_INVOCATION);
    expect(measured.drain.queries).toBeLessThan(PAID_QUERIES_PER_INVOCATION);
    // Measured: 265 queries (31 batches) each. A staged publication drains
    // the epoch it retired after its flip, so each pays for its own
    // reclamation, and the next one finds nothing left to drain first.
    expect(measured.broad.queries).toBeLessThanOrEqual(320);
    expect(measured.drain.queries).toBeLessThanOrEqual(320);
  });
});
