import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { migratePostgresInsightsSource } from "./db";
import { postgres } from "./postgres";
import {
  createPostgresInsightsSourceTools,
  postgresEventSourceShard,
} from "./postgresInsightsSource";
import type { Database } from "./types";

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};
const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(50);
  }
  throw new Error(
    "PostgreSQL source fixture did not reach the expected state.",
  );
};

describe("PostgreSQL committed source with concurrent transactions", () => {
  const container = `hot-updater-source-${randomUUID().slice(0, 8)}`;
  const writers: ReturnType<typeof postgres>[] = [];
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let config: pg.PoolConfig;
  let source: ReturnType<typeof createPostgresInsightsSourceTools>;

  beforeAll(async () => {
    docker(["image", "inspect", "postgres:15-alpine"]);
    const port = await findOpenPort();
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      container,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=128m",
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:15-alpine",
    ]);
    // The initialization server only listens on a socket. Wait for final TCP.
    await waitUntil(
      () =>
        spawnSync("docker", [
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ]).status === 0,
    );
    config = {
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
      max: 5,
    };
    pool = new pg.Pool(config);
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    await pool.query(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    await migratePostgresInsightsSource(db);
    source = createPostgresInsightsSourceTools(db);
    expect(await source.backfillStep(2)).toEqual({ ready: true, processed: 0 });
  });

  afterAll(async () => {
    await Promise.all(writers.map((writer) => writer.dispose?.()));
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  it("excludes an allocated but uncommitted event, serializes its shard, and permits a different shard to commit", async () => {
    const first = createBundleEventRowFixture("1", 5000);
    const shard = postgresEventSourceShard(first.id);
    const candidates = Array.from({ length: 100 }, (_, n) =>
      createBundleEventRowFixture(String(n + 2), 1),
    );
    const sameShard = candidates.find(
      (row) => postgresEventSourceShard(row.id) === shard,
    )!;
    const otherShard = candidates.find(
      (row) => postgresEventSourceShard(row.id) !== shard,
    )!;
    const bundle = createBundleRowFixture("801");
    const writer = (name: string) => {
      const result = postgres({ ...config, max: 1, application_name: name });
      writers.push(result);
      return result;
    };
    const firstWriter = writer("insights-source-first");
    const secondWriter = writer("insights-source-second");
    const independentWriter = writer("insights-source-independent");
    const blocker = await pool.connect();
    const lock = 731846;
    await blocker.query("select pg_advisory_lock($1)", [lock]);
    // The trigger pauses the real adapter after its counter UPDATE and INSERT,
    // before the mixed commit can publish either the event or the bundle.
    await pool.query(`create function pause_source_insert() returns trigger language plpgsql as $$
      begin if NEW.id = '${first.id}'::uuid then perform pg_advisory_xact_lock(${lock}); end if; return NEW; end; $$;
      create trigger pause_source_insert after insert on bundle_events for each row execute function pause_source_insert();`);
    let firstCommit: Promise<unknown> | undefined;
    let secondCommit: Promise<unknown> | undefined;
    try {
      firstCommit = firstWriter
        .commit({
          changes: [
            { model: "insights", operation: "insert", row: first },
            { model: "bundles", operation: "insert", row: bundle },
          ],
        })
        .then(
          (result) => result,
          (error: unknown) => ({ error }),
        );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "select 1 from pg_stat_activity where application_name = $1 and wait_event = 'advisory'",
              ["insights-source-first"],
            )
          ).rowCount === 1,
      );
      expect(JSON.parse(await source.capture())[2][shard]).toBe("0");
      expect(
        await independentWriter.models.bundles.findById(bundle.id),
      ).toBeNull();
      secondCommit = secondWriter.models.insights.append(sameShard).then(
        (result) => result,
        (error: unknown) => ({ error }),
      );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
              ["insights-source-second"],
            )
          ).rowCount === 1,
      );
      await independentWriter.models.insights.append(otherShard);
      const capturedWhileBlocked = await source.capture();
      expect(JSON.parse(capturedWhileBlocked)[2][shard]).toBe("0");
      expect(
        JSON.parse(capturedWhileBlocked)[2][
          postgresEventSourceShard(otherShard.id)
        ],
      ).toBe("1");
      await blocker.query("select pg_advisory_unlock($1)", [lock]);
      expect(await firstCommit).toEqual({ committed: true });
      expect(await secondCommit).toBeUndefined();
      const oldRows = (
        await Promise.all(
          Array.from({ length: 16 }, (_, shard) =>
            source.readPage({
              sourceGeneration: capturedWhileBlocked,
              shard,
              limit: 10,
            }),
          ),
        )
      ).flat();
      expect(oldRows.map(({ event }) => event.id)).toEqual([otherShard.id]);
      const current = await source.capture();
      expect(
        await source.readPage({ sourceGeneration: current, shard, limit: 10 }),
      ).toEqual([
        { sequence: "1", event: first },
        { sequence: "2", event: sameShard },
      ]);
      expect(
        await independentWriter.models.bundles.findById(bundle.id),
      ).toEqual(bundle);
    } finally {
      await blocker.query("select pg_advisory_unlock($1)", [lock]);
      blocker.release();
      await Promise.all([firstCommit, secondCommit]);
      await pool.query(
        "drop trigger pause_source_insert on bundle_events; drop function pause_source_insert()",
      );
    }
  });
});
