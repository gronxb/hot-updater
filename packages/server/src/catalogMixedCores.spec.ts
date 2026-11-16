import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  compileReleaseCatalog,
  createEngineDatabase,
  createSqlAdapter,
  type DatabaseAdapter,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  releaseRowToRelease,
  type SqlExecutor,
} from "@hot-updater/plugin-core";
import * as released from "@hot-updater/plugin-core-1.1.16";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import { createHotUpdater as createReleasedHotUpdater } from "@hot-updater/server-1.1.16";
import {
  createBundleFixture,
  createReleaseCatalogPartitionFixture,
  createReleaseCatalogTestStorage,
  probeAppVersions,
  setReleaseCatalogPartitioning,
} from "@hot-updater/test-utils";
import { pgliteExecutor, sqliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./createHotUpdaterCore";
import { createMigrator } from "./tooling.testFixtures";

/**
 * A released 1.1.16 server and this core, warm, over one database: the
 * processes a supported upgrade can leave behind (design §2.7, §15 item 9).
 * The switch is written by the test, as nothing in the product writes it
 * yet. Every answer either core gives is checked against today's compiler
 * over the scope's enabled releases.
 */

const PARTITIONS = "release_catalog_partitions";
const CHANNEL = "production";
const OTHER = "beta";
const scopeKeyOf = (channel: string) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey(channel),
    platform: "ios",
    strategy: "APP_VERSION",
  });

const backends = {
  sqlite: () => {
    const db = new DatabaseSync(":memory:");
    return {
      executor: sqliteExecutor(db) as SqlExecutor,
      count: async (sql: string) =>
        Number((db.prepare(sql).get() as { readonly n: number | bigint }).n),
      close: async () => db.close(),
    };
  },
  pglite: () => {
    const db = new PGlite();
    return {
      executor: pgliteExecutor(db) as SqlExecutor,
      count: async (sql: string) =>
        Number((await db.query<{ readonly n: number }>(sql)).rows[0]?.n ?? 0),
      close: () => db.close(),
    };
  },
};

const policy = (targetAppVersion: string, channel = CHANNEL) => ({
  channel,
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion,
});

type Core = {
  deploy: ReturnType<typeof createHotUpdater>["core"]["deploy"];
  updateReleasePolicy: ReturnType<
    typeof createHotUpdater
  >["core"]["updateReleasePolicy"];
  deleteRelease: ReturnType<typeof createHotUpdater>["core"]["deleteRelease"];
  promoteRelease: ReturnType<typeof createHotUpdater>["core"]["promoteRelease"];
  rebuildReleaseCatalog: ReturnType<
    typeof createHotUpdater
  >["core"]["rebuildReleaseCatalog"];
};

const open = async (name: keyof typeof backends) => {
  const backend = backends[name]();
  // The database as 1.1.16 migrated it.
  const oldAdapter = released.createSqlAdapter({
    executor: backend.executor as never,
  });
  await released.migrateCoreSchema(oldAdapter, name);
  const old = createReleasedHotUpdater({
    clientAccess: "public",
    database: released.createEngineDatabase({ adapter: oldAdapter, name }),
    storage: createReleaseCatalogTestStorage() as never,
  });
  // Warm: its fence keeps a success, so the 1.2 settings below don't stop it.
  await old.core.listReleaseCatalogs({ limit: 1 });

  // The same database migrated to 1.2.0, the table included.
  const adapter: DatabaseAdapter = createSqlAdapter({
    executor: backend.executor,
  });
  const current = createHotUpdater({
    clientAccess: "public",
    database: createEngineDatabase({ adapter, name }),
    storage: createReleaseCatalogTestStorage(),
  });
  await (
    await createMigrator(current).migrateToLatest({ updateSettings: true })
  ).execute();
  const fixture = createReleaseCatalogPartitionFixture(adapter);

  /** One answer from a handler's client route, past its 5 s memo. */
  const check = async (
    handlers: { readonly client: (request: Request) => Promise<Response> },
    appVersion: string,
    channel = CHANNEL,
  ) => {
    vi.setSystemTime(Date.now() + 6_000);
    const response = await handlers.client(
      new Request(
        `http://localhost/release-catalogs/app-version/ios/${encodeChannelKey(channel)}/${appVersion}`,
      ),
    );
    return { body: await response.text(), status: response.status };
  };

  /** Today's compile of the scope's enabled releases: what every answer must equal. */
  const expected = async (channel = CHANNEL) => {
    const releases = await current.core.listReleases({
      filter: { kind: "scope", scopeKey: scopeKeyOf(channel) },
      limit: 200,
    });
    const enabled = releases
      .filter((release) => release.enabled)
      .map(releaseRowToRelease);
    const compiled = (
      await compileReleaseCatalog({
        releases: enabled,
        strategy: "APP_VERSION",
      })
    ).payload;
    return {
      compiled,
      targets: releases.flatMap(({ target_app_version }) =>
        target_app_version === null ? [] : [target_app_version],
      ),
    };
  };

  /**
   * Every probed version's lists from `handlers` equal today's projection,
   * and every answer carries the scope's one catalog ID at `generation`.
   */
  const answersMatch = async (
    handlers: { readonly client: (request: Request) => Promise<Response> },
    channel = CHANNEL,
  ) => {
    const { compiled, targets } = await expected(channel);
    const seen = new Set<string>();
    const generations = new Set<number>();
    for (const version of probeAppVersions(compiled, targets)) {
      const { body, status } = await check(handlers, version, channel);
      expect(status, `${channel} ${version}`).toBe(200);
      const answer = JSON.parse(body) as ReleaseCatalog;
      expect(answer.releases, `${channel} ${version}`).toEqual(
        projectCompiledCatalog(compiled, version),
      );
      expect(answer.rollbackReleases, `${channel} ${version}`).toEqual(
        projectCompiledRollbackCatalog(compiled, version),
      );
      seen.add(answer.catalogId);
      generations.add(answer.generation);
    }
    expect(seen.size).toBe(1);
    expect(generations.size).toBe(1);
    return { catalogId: [...seen][0]!, generation: [...generations][0]! };
  };

  const partitionRows = () =>
    backend.count(`SELECT COUNT(*) AS n FROM "${PARTITIONS}"`);
  const headOf = async (channel = CHANNEL) => {
    const row = await fixture.readRow(scopeKeyOf(channel));
    return {
      catalogId: row.catalog_id,
      generation: row.generation,
      epoch: row.payload.includes('"layout":')
        ? (JSON.parse(row.payload).epoch as string)
        : null,
    };
  };

  const deployOn = async (
    core: Core,
    suffix: string,
    range: string,
    channel = CHANNEL,
  ) =>
    (
      await core.deploy([
        {
          bundle: createBundleFixture(suffix),
          release: policy(range, channel),
        },
      ])
    )[0]!.release!;

  return {
    answersMatch,
    backend,
    check,
    current,
    deployOn,
    fixture,
    headOf,
    old,
    oldCore: old.core as unknown as Core,
    newCore: current.core as unknown as Core,
    partitionRows,
  };
};

describe.each(Object.keys(backends) as (keyof typeof backends)[])(
  "a released 1.1.16 server and this core on one database (%s)",
  (name) => {
    let env: Awaited<ReturnType<typeof open>>;
    const errors: unknown[][] = [];
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.spyOn(console, "error").mockImplementation((...args) => {
        errors.push(args);
      });
      env = await open(name);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      errors.length = 0;
      await env.backend.close();
    });

    it("a cold 1.1.16 core is fenced on the 1.2.0 database; the warm one serves it", async () => {
      await env.deployOn(env.newCore, "100", "1.0.0");
      const cold = createReleasedHotUpdater({
        clientAccess: "public",
        database: released.createEngineDatabase({
          adapter: released.createSqlAdapter({
            executor: env.backend.executor as never,
          }),
          name,
        }),
        storage: createReleaseCatalogTestStorage() as never,
      });
      expect((await env.check(cold.handlers, "1.0.0")).status).toBe(503);
      expect((await env.check(env.old.handlers, "1.0.0")).status).toBe(200);
    });

    it("with the switch off, both cores write and answer as today, and nothing converts", async () => {
      const one = await env.deployOn(env.newCore, "101", "1.0.0");
      await env.deployOn(env.oldCore, "102", ">=1.0.0 <2.0.0");
      await env.deployOn(env.newCore, "103", "2.0.0");
      await env.newCore.updateReleasePolicy({
        releaseId: one.id,
        patch: { enabled: false },
      });
      await env.oldCore.deleteRelease({ releaseId: one.id });
      await env.newCore.promoteRelease({
        releaseId: (await env.deployOn(env.oldCore, "104", "*")).id,
        targetChannel: OTHER,
      });
      await env.newCore.rebuildReleaseCatalog(scopeKeyOf(CHANNEL));

      for (const handlers of [env.old.handlers, env.current.handlers]) {
        await env.answersMatch(handlers);
        await env.answersMatch(handlers, OTHER);
      }
      expect(await env.partitionRows()).toBe(0);
      expect((await env.headOf()).epoch).toBeNull();
    });

    it("with the switch on: old readers fail closed on a head, old writers write compact over it, and the next write converts again", async () => {
      const generations: number[] = [];
      const record = async () => {
        const head = await env.headOf();
        generations.push(head.generation);
        return head;
      };
      await env.deployOn(env.oldCore, "201", "1.0.0");
      await env.deployOn(env.newCore, "202", ">=1.0.0 <3.0.0");
      const { catalogId } = await record();
      await setReleaseCatalogPartitioning(env.current.database.adapter, "on");

      // A 1.2 write converts the scope.
      await env.deployOn(env.newCore, "203", "2.0.0");
      const converted = await record();
      expect(converted.epoch).not.toBeNull();
      expect(await env.partitionRows()).toBeGreaterThan(0);
      await env.answersMatch(env.current.handlers);

      // The released reader fails closed: 500 from parsing the head, never an empty 200.
      errors.length = 0;
      for (const version of ["1.0.0", "2.0.0", "2.5.0", "9.9.9"]) {
        const { status } = await env.check(env.old.handlers, version);
        expect(status, version).toBe(500);
      }
      expect(errors.length).toBeGreaterThan(0);
      for (const [message, error] of errors) {
        expect(message).toBe("Hot Updater handler error:");
        expect(String((error as Error).message)).toMatch(
          /Release catalog payload is invalid/,
        );
      }

      // The released writer replaces the head with a compact row at G+1.
      const old = await env.deployOn(env.oldCore, "204", "1.0.0");
      const compact = await record();
      expect(compact.epoch).toBeNull();
      expect(compact.catalogId).toBe(catalogId);
      await env.answersMatch(env.current.handlers);
      await env.answersMatch(env.old.handlers);
      const retired = converted.epoch!;
      expect(
        (await env.fixture.rows(scopeKeyOf(CHANNEL))).some(
          (row) => row.epoch === retired,
        ),
      ).toBe(true);

      // The next 1.2 write converts again, into a new epoch.
      await env.newCore.updateReleasePolicy({
        releaseId: old.id,
        patch: { message: "edited by 1.2" },
      });
      const reconverted = await record();
      expect(reconverted.epoch).not.toBeNull();
      expect(reconverted.epoch).not.toBe(retired);
      await env.answersMatch(env.current.handlers);

      // Conflicting pair, back to back; deletes, promotes and rebuilds from both.
      await env.oldCore.updateReleasePolicy({
        releaseId: old.id,
        patch: { enabled: false },
      });
      await record();
      await env.newCore.deleteRelease({ releaseId: old.id });
      await record();
      await env.answersMatch(env.current.handlers);
      const promoted = await env.deployOn(env.oldCore, "205", "*");
      await record();
      await env.newCore.promoteRelease({
        releaseId: promoted.id,
        targetChannel: OTHER,
        action: "move",
      });
      await record();
      await env.answersMatch(env.current.handlers);
      await env.answersMatch(env.current.handlers, OTHER);
      await env.oldCore.rebuildReleaseCatalog(scopeKeyOf(CHANNEL));
      await env.newCore.rebuildReleaseCatalog(scopeKeyOf(CHANNEL));
      await env.deployOn(env.newCore, "206", "3.0.0");
      const last = await record();
      expect(last.epoch).not.toBeNull();
      await env.answersMatch(env.current.handlers);

      // Each 1.2 write runs one cleanup step: a page of a retired epoch's
      // rows, or its marker. Further writes reclaim every retired epoch, two
      // steps each here (one page, then the marker), and garbage never grows.
      const garbage = async () => {
        const rows = await env.fixture.rows(scopeKeyOf(CHANNEL));
        const live = (await env.headOf()).epoch;
        return {
          epochs: new Set(
            rows.flatMap((row) =>
              row.epoch === "!"
                ? []
                : [row.epoch === "#" ? row.lowerKey : row.epoch],
            ),
          ),
          items: rows.filter(
            (row) =>
              row.epoch !== "!" &&
              (row.epoch === "#" ? row.lowerKey : row.epoch) !== live,
          ).length,
        };
      };
      const retiredEpochs = (await garbage()).epochs.size - 1;
      expect(retiredEpochs).toBeGreaterThan(0);
      let left = (await garbage()).items;
      for (let write = 0; write < 2 * retiredEpochs; write += 1) {
        await env.newCore.updateReleasePolicy({
          releaseId: promoted.id,
          patch: { message: `edit ${write}` },
        });
        const now = (await garbage()).items;
        expect(now).toBeLessThan(left === 0 ? 1 : left);
        left = now;
      }
      const last2 = await record();
      expect([...(await garbage()).epochs]).toEqual([last2.epoch]);

      // One catalog ID throughout; generations only grow.
      expect(last.catalogId).toBe(catalogId);
      for (let index = 1; index < generations.length; index += 1) {
        expect(generations[index]!).toBeGreaterThan(generations[index - 1]!);
      }
    });

    it("tombstones: the last release disabled by either core leaves a compact tombstone, and a deploy after it converts", async () => {
      await setReleaseCatalogPartitioning(env.current.database.adapter, "on");
      const first = await env.deployOn(env.newCore, "301", "1.0.0");
      expect((await env.headOf()).epoch).not.toBeNull();
      await env.oldCore.updateReleasePolicy({
        releaseId: first.id,
        patch: { enabled: false },
      });
      expect((await env.headOf()).epoch).toBeNull();
      await env.newCore.updateReleasePolicy({
        releaseId: first.id,
        patch: { enabled: true },
      });
      expect((await env.headOf()).epoch).not.toBeNull();
      await env.newCore.updateReleasePolicy({
        releaseId: first.id,
        patch: { enabled: false },
      });
      const tombstone = await env.fixture.readRow(scopeKeyOf(CHANNEL));
      expect(tombstone.is_tombstone).toBe(true);
      expect(tombstone.payload).not.toContain('"layout":');
      for (const handlers of [env.old.handlers, env.current.handlers]) {
        const { status, body } = await env.check(handlers, "1.0.0");
        expect(status).toBe(200);
        expect(JSON.parse(body).releases).toEqual([]);
      }
      await env.deployOn(env.oldCore, "302", "2.0.0");
      await env.deployOn(env.newCore, "303", "2.0.0");
      expect((await env.headOf()).epoch).not.toBeNull();
      await env.answersMatch(env.current.handlers);
    });
  },
);
