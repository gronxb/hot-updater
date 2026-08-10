// @ts-expect-error cloudflare:test is provided by the Cloudflare Vitest pool.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { D1Executor } from "../../../plugins/cloudflare/src/d1Implementation";
import { createD1UniversalComponentDataAdapter } from "../../../plugins/cloudflare/src/d1UniversalComponentData";
import { analyticsComponentSchema } from "./componentSchema";

type D1Statement = Parameters<D1Executor["batch"]>[0][number];
type D1Value = null | number | string;

interface TestD1Result<Row> {
  readonly results: readonly Row[];
}

interface TestD1PreparedStatement {
  all<Row>(): Promise<TestD1Result<Row>>;
  bind(...values: readonly D1Value[]): TestD1PreparedStatement;
  first<Row>(columnName?: string): Promise<Row | null>;
  run(): Promise<unknown>;
}

interface TestD1Database {
  batch(statements: readonly TestD1PreparedStatement[]): Promise<unknown>;
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): TestD1PreparedStatement;
}

const database = (env as { readonly DB: TestD1Database }).DB;

class WorkerD1Executor implements D1Executor {
  readonly batches: D1Statement[][] = [];
  readonly queries: D1Statement[] = [];

  async batch(statements: readonly D1Statement[]): Promise<void> {
    this.batches.push(
      statements.map(({ params, sql }) => ({ params: [...params], sql })),
    );
    await database.batch(
      statements.map(({ params, sql }) =>
        database.prepare(sql).bind(...params),
      ),
    );
  }

  async query(
    sql: string,
    params: readonly string[],
  ): Promise<readonly unknown[]> {
    this.queries.push({ params: [...params], sql });
    return (
      await database
        .prepare(sql)
        .bind(...params)
        .all()
    ).results;
  }
}

const analyticsColumns = [
  "id",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_bundle_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
  "received_at_ms",
] as const;

type StoredValue = D1Value;
type StoredEvent = {
  readonly [Column in (typeof analyticsColumns)[number]]: StoredValue;
};

const legacyV1Table = `
  CREATE TABLE bundle_events (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    install_id TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    from_bundle_id TEXT NOT NULL,
    to_bundle_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    cohort TEXT NOT NULL,
    update_strategy TEXT NOT NULL,
    fingerprint_hash TEXT,
    sdk_version TEXT,
    received_at_ms REAL NOT NULL,
    CONSTRAINT bundle_events_type_check
      CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED')),
    CONSTRAINT bundle_events_update_strategy_check
      CHECK (update_strategy IN ('fingerprint', 'appVersion'))
  )
`;

const legacyV1Indexes = [
  "CREATE INDEX bundle_events_installed_bundle_idx ON bundle_events(type, to_bundle_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_recovered_bundle_idx ON bundle_events(type, from_bundle_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_install_idx ON bundle_events(install_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_user_id_idx ON bundle_events(user_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_username_idx ON bundle_events(username, received_at_ms, id)",
  "CREATE INDEX bundle_events_cohort_idx ON bundle_events(cohort, type, received_at_ms, id)",
  "CREATE INDEX bundle_events_received_at_idx ON bundle_events(received_at_ms, id)",
] as const;

const event = (
  id: string,
  overrides: Partial<StoredEvent> = {},
): StoredEvent => ({
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  fingerprint_hash: null,
  from_bundle_id: "bundle-a",
  id,
  install_id: "install-1",
  platform: "ios",
  received_at_ms: 100,
  sdk_version: null,
  to_bundle_id: "bundle-b",
  type: "UPDATE_APPLIED",
  update_strategy: "fingerprint",
  user_id: null,
  username: null,
  ...overrides,
});

const insertStatement = (row: StoredEvent): TestD1PreparedStatement =>
  database
    .prepare(
      `INSERT INTO bundle_events (${analyticsColumns.join(", ")})
     VALUES (${analyticsColumns.map(() => "?").join(", ")})`,
    )
    .bind(...analyticsColumns.map((column) => row[column]));

describe("Analytics schema on the generic D1 adapter", () => {
  let executor: WorkerD1Executor;
  let adapter: ReturnType<typeof createD1UniversalComponentDataAdapter>;

  beforeEach(async () => {
    await database.batch(
      [
        "DROP TABLE IF EXISTS bundle_events",
        'DROP TABLE IF EXISTS "_hot_updater_analytics_bundle_events_2"',
        "DROP TABLE IF EXISTS private_hot_updater_settings",
      ].map((sql) => database.prepare(sql)),
    );
    await database
      .prepare(`
      CREATE TABLE private_hot_updater_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )
    `)
      .run();
    executor = new WorkerD1Executor();
    adapter = createD1UniversalComponentDataAdapter(executor);
  });

  const setSetting = async (key: string, value: string): Promise<void> => {
    await database
      .prepare(
        `INSERT INTO private_hot_updater_settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value)
      .run();
  };

  const setting = async (key: string): Promise<string | null> =>
    database
      .prepare("SELECT value FROM private_hot_updater_settings WHERE key = ?")
      .bind(key)
      .first<string>("value");

  const insertEvent = async (row: StoredEvent): Promise<void> => {
    await insertStatement(row).run();
  };

  const storedEvent = async (
    id: string,
  ): Promise<Record<string, StoredValue> | null> =>
    database
      .prepare(
        `SELECT ${analyticsColumns.join(", ")}
       FROM bundle_events WHERE id = ?`,
      )
      .bind(id)
      .first<Record<string, StoredValue>>();

  const createExactV2Catalog = async (): Promise<void> => {
    const artifact = adapter.artifacts?.(analyticsComponentSchema)[0];
    if (artifact === undefined) {
      throw new TypeError("Generic D1 Analytics artifact is missing");
    }
    await database.exec(artifact.contents);
  };

  const migrate = () => {
    if (adapter.migrate === undefined) {
      throw new TypeError("Generic D1 component migration is missing");
    }
    return adapter.migrate(analyticsComponentSchema);
  };

  it("migrates the immutable 0.37 v1 catalog without losing its row", async () => {
    await setSetting("version", "0.37.0");
    await database.prepare(legacyV1Table).run();
    await database.batch(legacyV1Indexes.map((sql) => database.prepare(sql)));
    const legacyEvent = event("legacy-event");
    await insertEvent(legacyEvent);

    await expect(migrate()).resolves.toEqual({
      changed: true,
      version: "2",
    });

    await expect(setting("schema.analytics")).resolves.toBe("2");
    await expect(storedEvent("legacy-event")).resolves.toEqual(legacyEvent);
    const columns = await database
      .prepare("PRAGMA table_info(bundle_events)")
      .all<{ readonly name: string; readonly notnull: number }>();
    expect(
      columns.results.find(({ name }) => name === "from_bundle_id")?.notnull,
    ).toBe(0);
  });

  it("adopts an exact unmarked v2 catalog without rebuilding its rows", async () => {
    await setSetting("version", "0.38.0");
    await createExactV2Catalog();
    await database
      .prepare(
        "DELETE FROM private_hot_updater_settings WHERE key = 'schema.analytics'",
      )
      .run();
    const existing = event("unmarked-v2");
    await insertEvent(existing);
    const batchCount = executor.batches.length;

    await expect(migrate()).resolves.toEqual({
      changed: true,
      version: "2",
    });

    await expect(storedEvent("unmarked-v2")).resolves.toEqual(existing);
    expect(executor.batches).toHaveLength(batchCount + 1);
    expect(executor.batches.at(-1)).toHaveLength(1);
    expect(executor.batches.at(-1)?.[0]?.sql).toContain(
      "'schema.analytics', '2'",
    );
  });

  it("recovers latest physical state when only marker 1 remains", async () => {
    await setSetting("version", "0.37.0");
    await createExactV2Catalog();
    await setSetting("schema.analytics", "1");
    const existing = event("interrupted-marker");
    await insertEvent(existing);

    await expect(migrate()).resolves.toEqual({
      changed: true,
      version: "2",
    });

    await expect(setting("schema.analytics")).resolves.toBe("2");
    await expect(storedEvent("interrupted-marker")).resolves.toEqual(existing);
    expect(executor.batches.at(-1)).toHaveLength(1);
  });

  it("reaches a corrupt row after the first 500-row validation page", async () => {
    await setSetting("version", "0.38.0");
    await createExactV2Catalog();
    await database
      .prepare(
        "DELETE FROM private_hot_updater_settings WHERE key = 'schema.analytics'",
      )
      .run();
    const events = Array.from({ length: 501 }, (_, index) =>
      event(`event-${String(index).padStart(4, "0")}`, {
        platform: index === 500 ? "windows" : "ios",
        received_at_ms: index,
      }),
    );
    for (let offset = 0; offset < events.length; offset += 100) {
      await database.batch(
        events.slice(offset, offset + 100).map(insertStatement),
      );
    }

    await expect(migrate()).rejects.toThrow(/Invalid row/);

    await expect(setting("schema.analytics")).resolves.toBeNull();
    const validationQueries = executor.queries.filter(
      ({ sql }) =>
        sql.startsWith('SELECT "id", "type"') &&
        sql.includes('FROM "bundle_events"'),
    );
    expect(validationQueries).toHaveLength(2);
    expect(validationQueries[1]?.params).toEqual(["event-0499"]);
  });

  it("writes the marker last, rolls back its failure, and is idempotent", async () => {
    await setSetting("version", "0.36.0");
    await database
      .prepare(`
      CREATE TRIGGER reject_analytics_marker
      BEFORE INSERT ON private_hot_updater_settings
      WHEN NEW.key = 'schema.analytics'
      BEGIN
        SELECT RAISE(ABORT, 'forced marker failure');
      END
    `)
      .run();

    await expect(migrate()).rejects.toThrow(/forced marker failure/);
    await expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bundle_events'",
        )
        .first(),
    ).resolves.toBeNull();
    await expect(setting("schema.analytics")).resolves.toBeNull();

    await database.prepare("DROP TRIGGER reject_analytics_marker").run();
    await expect(migrate()).resolves.toEqual({
      changed: true,
      version: "2",
    });
    const successfulBatch = executor.batches.at(-1);
    expect(successfulBatch?.at(-1)?.sql).toContain("'schema.analytics', '2'");
    const batchCount = executor.batches.length;

    await expect(migrate()).resolves.toEqual({
      changed: false,
      version: "2",
    });
    expect(executor.batches).toHaveLength(batchCount);
  });
});
