import { PGlite } from "@electric-sql/pglite";
import { assembleServer, p } from "@hot-updater/cli-tools";
import {
  createEngineDatabase,
  createSqlAdapter,
  migrateCoreSchema,
  SETTINGS_TABLE,
  type DatabaseAdapter,
  type ToolingDatabase,
} from "@hot-updater/plugin-core";
import type {
  BundleEventRow,
  InsightsApi,
} from "@hot-updater/plugin-insights/server";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins";
import {
  createBundleEventRowFixture,
  createReleaseCatalogTestStorage,
  insights11TestPlugin,
  type Insights11TestApi,
} from "@hot-updater/test-utils";
import { pgliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "./migrate";
import { loadHotUpdater } from "./utils/load-hot-updater";

// The spinner is silenced; `p.log` stays the object cli-tools logs through
// itself, so its calls are spied on there.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: {
      ...actual.p,
      spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
    },
  };
});

vi.mock("./utils/load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/load-hot-updater")>()),
  findDefaultConfigPaths: vi.fn(() => []),
  loadHotUpdater: vi.fn(),
}));

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const exits: (number | undefined)[] = [];

/** Runs `hot-updater db migrate --yes` and returns the code it exits with. */
const runMigrate = async (): Promise<number | undefined> => {
  exits.length = 0;
  try {
    await migrate({ configPath: "src/hotUpdater.ts", skipConfirm: true });
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
  }
  return exits[0];
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Recent hours, so the raw period holds them.
const base = Date.now() - (Date.now() % HOUR) - 6 * HOUR;
const artifact = createBundleEventRowFixture("9900", 0).to_bundle_id;
const v3 = "00000000-0000-7000-8000-000000009903";
const v4 = "00000000-0000-7000-8000-000000009904";
const v5 = "00000000-0000-7000-8000-000000009905";

/** An event on one artifact, which releases v3 and v5 both serve. */
const event = (
  suffix: string,
  at: number,
  fields: Partial<BundleEventRow>,
): BundleEventRow =>
  ({
    ...createBundleEventRowFixture(suffix, base + at),
    to_bundle_id: artifact,
    ...fields,
  }) as BundleEventRow;

const scope = { platform: "ios", channel: "production" } as const;

/** Release health's counts of one release, as the Console reads them. */
const health = (api: InsightsApi, releaseId: string) => {
  const count = (
    filter:
      | { readonly type: "UPDATE_APPLIED"; readonly toReleaseId: string }
      | { readonly type: "RECOVERED"; readonly fromReleaseId: string },
  ) =>
    api.countEvents({
      filter: { ...scope, ...filter },
      sinceMs: base - DAY,
      beforeReceivedAtMs: base + DAY,
    });
  return Promise.all([
    count({ type: "UPDATE_APPLIED", toReleaseId: releaseId }),
    count({ type: "RECOVERED", fromReleaseId: releaseId }),
  ]).then(([launched, crashed]) => ({ launched, crashed }));
};

describe("db migrate on a database a 1.1 server's Insights wrote", () => {
  let pglite: PGlite;
  let adapter: DatabaseAdapter;
  let log: Record<"info" | "success", ReturnType<typeof vi.fn>>;

  /** A server over the database, as one run of the CLI assembles it. */
  const serve = (database: ToolingDatabase) => {
    const server = assembleServer({ database, plugins: [insights()] });
    vi.mocked(loadHotUpdater).mockResolvedValue({
      hotUpdater: server,
    } as never);
    return server;
  };

  /** A 1.1 server's Insights, which keys what it records by artifact. */
  const oneDotOne = () =>
    createHotUpdater({
      database: createEngineDatabase({ name: "postgres", adapter }),
      storage: createReleaseCatalogTestStorage(),
      plugins: [insights11TestPlugin()],
      clientAccess: "public",
    }).api.insights as unknown as Insights11TestApi;

  beforeEach(async () => {
    vi.clearAllMocks();
    log = {
      info: vi.spyOn(p.log, "info").mockImplementation(() => {}),
      success: vi.spyOn(p.log, "success").mockImplementation(() => {}),
    } as never;
    vi.spyOn(p.log, "error").mockImplementation(() => {});
    vi.spyOn(p.log, "message").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Exit(code);
    }) as never);
    pglite = new PGlite();
    adapter = createSqlAdapter({ executor: pgliteExecutor(pglite) });
    await migrateCoreSchema(adapter, "postgres", [insights()]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pglite.close();
  });

  /**
   * v3 launched twice and crashed once, v5 of the same artifact launched
   * three times, and the built-in bundle once, all recorded by 1.1; then the
   * schema as 1.1 left it: no labels, no `byBundle` key index, core 1.0.0.
   */
  const asWrittenByOneDotOne = async () => {
    const legacy = oneDotOne();
    const onV3 = { to_release_id: v3 };
    const onV5 = { to_release_id: v5 };
    for (const row of [
      event("9910", 0, onV3),
      event("9911", 1, onV3),
      event("9912", HOUR, {
        type: "RECOVERED",
        from_bundle_id: artifact,
        from_release_id: v3,
        to_release_id: v4,
      }),
      event("9913", 2 * HOUR, onV5),
      event("9914", 2 * HOUR + 1, onV5),
      event("9915", 2 * HOUR + 2, onV5),
      // A launch of the built-in bundle names no release.
      event("9916", 3 * HOUR, {}),
    ]) {
      await legacy.record(row);
    }
    const { rows } = await pglite.query<{ indexname: string }>(
      `SELECT "indexname" FROM pg_indexes WHERE "indexname" LIKE '%byBundle\\_\\_key'`,
    );
    expect(rows).toHaveLength(1);
    await pglite.exec(
      [
        `DROP INDEX "${rows[0]!.indexname}"`,
        'DROP INDEX "releases_byLabel"',
        'ALTER TABLE "releases" DROP COLUMN "label"',
        'DROP TABLE "label_sequences"',
      ].join("; "),
    );
    await pglite.query(
      `UPDATE "${SETTINGS_TABLE.name}" SET "value" = '1.0.0' WHERE "key" = 'schema.core'`,
    );
  };

  it("migrates the schema, then moves the events and counts 1.1 keyed by artifact to their releases, once", async () => {
    await asWrittenByOneDotOne();
    const server = serve(createEngineDatabase({ name: "postgres", adapter }));
    const api = server.api.insights as InsightsApi;

    await expect(runMigrate()).resolves.toBe(0);

    expect(log.info.mock.calls).toEqual([
      ["Moved 6 Insights events from their artifacts to their releases."],
    ]);
    // v5 has no crash of v3's, and each keeps its own launches.
    await expect(health(api, v3)).resolves.toEqual({ launched: 2, crashed: 1 });
    await expect(health(api, v5)).resolves.toEqual({ launched: 3, crashed: 0 });
    await expect(
      api.countEvents({
        filter: { ...scope, type: "UPDATE_APPLIED", toReleaseId: artifact },
        sinceMs: base - DAY,
        beforeReceivedAtMs: base + DAY,
      }),
    ).resolves.toBe(1);

    log.info.mockClear();
    serve(createEngineDatabase({ name: "postgres", adapter }));
    await expect(runMigrate()).resolves.toBe(0);
    expect(log.success.mock.calls.at(-1)).toEqual(["Schema is up to date."]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("moves what a 1.1 server still running recorded after the migration when db migrate runs again", async () => {
    await asWrittenByOneDotOne();
    const server = serve(createEngineDatabase({ name: "postgres", adapter }));
    const api = server.api.insights as InsightsApi;
    await expect(runMigrate()).resolves.toBe(0);

    // A 1.1 process started before the migration keeps recording by artifact.
    await oneDotOne().record(event("9917", 4 * HOUR, { to_release_id: v5 }));
    await expect(health(api, v5)).resolves.toEqual({ launched: 3, crashed: 0 });
    log.info.mockClear();

    serve(createEngineDatabase({ name: "postgres", adapter }));
    await expect(runMigrate()).resolves.toBe(0);

    expect(log.info.mock.calls).toEqual([
      ["Moved 1 Insights event from its artifact to its release."],
    ]);
    await expect(health(api, v5)).resolves.toEqual({ launched: 4, crashed: 0 });
  });

  it("moves them on a database without a migrator, whose schema its provider applies", async () => {
    await asWrittenByOneDotOne();
    // The provider's migration files bring the schema to this release.
    await migrateCoreSchema(adapter, "postgres", [insights()]);
    const { createMigrator: _, ...database } = createEngineDatabase({
      name: "supabaseDatabase",
      adapter,
    });
    const server = serve({
      ...database,
      generateSchema: () => ({ code: "", path: "migrations/0001.sql" }),
    } as ToolingDatabase);

    await expect(runMigrate()).resolves.toBe(0);

    expect(log.success.mock.calls).toEqual([["Schema is up to date."]]);
    expect(log.info.mock.calls).toEqual([
      ["Moved 6 Insights events from their artifacts to their releases."],
    ]);
    await expect(
      health(server.api.insights as InsightsApi, v3),
    ).resolves.toEqual({ launched: 2, crashed: 1 });
  });
});
