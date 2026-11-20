import { PGlite } from "@electric-sql/pglite";
import { assembleServer, p } from "@hot-updater/cli-tools";
import {
  createEngineDatabase,
  createSqlAdapter,
  migrateCoreSchema,
  SETTINGS_TABLE,
  type Deployment,
} from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
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
  loadHotUpdater: vi.fn(),
}));

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const exits: (number | undefined)[] = [];

/**
 * Runs `hot-updater db migrate --yes`: the exit code it ends with, the first
 * `process.exit`, which stops the command there.
 */
const runMigrate = async (): Promise<number | undefined> => {
  exits.length = 0;
  try {
    await migrate({ configPath: "src/hotUpdater.ts", skipConfirm: true });
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
  }
  return exits[0];
};

const policy = (
  channel: string,
  fingerprintHash: string,
): Deployment["release"] => ({
  channel,
  enabled: true,
  fingerprintHash,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: null,
});

let sequence = 0;
const bundle = (platform: "ios" | "android" = "ios") => {
  sequence += 1;
  const id = `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
  return {
    id,
    platform,
    gitCommitHash: null,
    manifestStorageUri: `storage://artifacts/${id}/manifest.json`,
    manifestFileHash: `manifest-hash-${id}`,
    assetBaseStorageUri: "storage://assets",
  } as const;
};

describe("db migrate on a database a 1.1 server wrote", () => {
  let pglite: PGlite;
  let server: ReturnType<typeof assembleServer>;

  let log: Record<
    "error" | "info" | "message" | "success",
    ReturnType<typeof vi.fn>
  >;

  beforeEach(async () => {
    vi.clearAllMocks();
    log = {
      error: vi.spyOn(p.log, "error").mockImplementation(() => {}),
      info: vi.spyOn(p.log, "info").mockImplementation(() => {}),
      message: vi.spyOn(p.log, "message").mockImplementation(() => {}),
      success: vi.spyOn(p.log, "success").mockImplementation(() => {}),
    } as never;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Exit(code);
    }) as never);
    pglite = new PGlite();
    const adapter = createSqlAdapter({ executor: pgliteExecutor(pglite) });
    await migrateCoreSchema(adapter, "postgres", []);
    server = assembleServer({
      database: createEngineDatabase({ name: "postgres", adapter }),
    });
    vi.mocked(loadHotUpdater).mockResolvedValue({
      hotUpdater: server,
    } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pglite.close();
  });

  /** Releases on two channels, two fingerprints and both platforms, as 1.1 left them. */
  const asWrittenByOneDotOne = async () => {
    const deployed = [];
    for (const [channel, fingerprint, platform] of [
      ["production", "a", "ios"],
      ["production", "b", "ios"],
      ["beta", "a", "ios"],
      ["production", "a", "ios"],
      ["production", "a", "android"],
      ["production", "b", "ios"],
    ] as const) {
      const [result] = await server.core.deploy([
        { bundle: bundle(platform), release: policy(channel, fingerprint) },
      ]);
      deployed.push(result!.release!);
    }
    await pglite.exec(
      'UPDATE "releases" SET "label" = NULL; DELETE FROM "label_sequences"',
    );
    // Each catalog as 1.1 compiled it: without labels.
    for (const scopeKey of new Set(
      deployed.map(({ scope_key }) => scope_key),
    )) {
      await server.core.rebuildReleaseCatalog(scopeKey);
    }
    await pglite.exec(
      'DROP INDEX "releases_byLabel"; ALTER TABLE "releases" DROP COLUMN "label"; DROP TABLE "label_sequences"',
    );
    await pglite.query(
      `UPDATE "${SETTINGS_TABLE.name}" SET "value" = '1.0.0' WHERE "key" = 'schema.core'`,
    );
    return deployed;
  };

  const labels = async (channel: string, platform: "ios" | "android") =>
    (
      await server.core.listReleases({
        filter: {
          kind: "channelPlatform",
          channelId: `channel:${encodeChannelKey(channel)}`,
          platform,
        },
        limit: 100,
      })
    ).map(({ id, label }) => [id, label]);

  it("adds the column, labels each channel and platform's releases in creation order, and rebuilds their catalogs", async () => {
    const deployed = await asWrittenByOneDotOne();

    await expect(runMigrate()).resolves.toBe(0);

    expect(log.info.mock.calls).toEqual([
      ["Labeled 6 releases and rebuilt 4 release catalogs."],
    ]);
    const inIdOrder = (rows: typeof deployed) =>
      rows.map(({ id }) => id).sort();
    const production = inIdOrder(
      deployed.filter(
        ({ channel_id, platform }) =>
          channel_id === deployed[0]!.channel_id && platform === "ios",
      ),
    );
    await expect(labels("production", "ios")).resolves.toEqual(
      production.map((id, index) => [id, index + 1]),
    );
    await expect(labels("beta", "ios")).resolves.toEqual([
      [deployed[2]!.id, 1],
    ]);
    await expect(labels("production", "android")).resolves.toEqual([
      [deployed[4]!.id, 1],
    ]);
    await expect(
      server.core.fillReleaseLabels({ dryRun: true }),
    ).resolves.toEqual({ releases: 0, catalogs: 0 });
    const [newest] = await server.core.deploy([
      { bundle: bundle(), release: policy("production", "a") },
    ]);
    expect(newest!.release!.label).toBe(5);
  });

  it("labels a release a 1.1 server wrote after the migration when db migrate runs again", async () => {
    await asWrittenByOneDotOne();
    await expect(runMigrate()).resolves.toBe(0);
    // A 1.1 server still running writes a release without a label, and
    // takes nothing from the counter.
    const [stale] = await server.core.deploy([
      { bundle: bundle(), release: policy("production", "b") },
    ]);
    await pglite.query('UPDATE "releases" SET "label" = NULL WHERE "id" = $1', [
      stale!.release!.id,
    ]);
    await pglite.query(
      `UPDATE "label_sequences" SET "last_label" = "last_label" - 1 WHERE "id" = $1`,
      [`releases/ios/${stale!.release!.channel_id}`],
    );
    // It compiles the scope's catalog without the release's label.
    await server.core.rebuildReleaseCatalog(stale!.release!.scope_key);
    log.info.mockClear();

    await expect(runMigrate()).resolves.toBe(0);

    expect(log.success.mock.calls.at(-1)).toEqual(["Schema is up to date."]);
    expect(log.info.mock.calls).toEqual([
      ["Labeled 1 release and rebuilt 1 release catalog."],
    ]);
    await expect(
      server.core.getRelease(stale!.release!.id),
    ).resolves.toMatchObject({ label: 5 });
  });
});
