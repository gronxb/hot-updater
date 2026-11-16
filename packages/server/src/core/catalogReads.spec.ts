import {
  assembleReleaseCatalog,
  compileReleaseCatalog,
  compileReleaseCatalogTiling,
  createMemoryAdapter,
  type DatabaseAdapter,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  releaseRowToRelease,
  semverSatisfies,
  type ReleaseCatalogPartition,
  type ReleaseCatalogRow,
  type SnapshotReader,
  targetBaseCandidateKey,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type Release,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import {
  cohortClasses,
  createBundleFixture,
  createReleaseCatalogPartitionFixture,
  decideReleaseCatalog,
  deviceStates,
  probeAppVersions,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdaterHandlers } from "../handler";
import type { CoreApi } from "./api";
import { ReleaseCatalogReadConflictError } from "./catalogReads";
import { createInProcessCoreApi } from "./inProcess.testFixtures";

const CHANNEL = "production";
const channelKey = encodeChannelKey(CHANNEL);
const scopeKeyOf = (channel = CHANNEL) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey(channel),
    platform: "ios",
    strategy: "APP_VERSION",
  });

interface Hooks {
  /** Runs after each direct read of `table`, before its caller sees the rows. */
  afterRead?: (table: string, kind: "get" | "query") => Promise<void>;
  /** Runs before a snapshot opens: a write here lands before the snapshot's state. */
  beforeSnapshot?: () => Promise<void>;
}

/**
 * The memory adapter with read hooks, so a spec writes between two reads,
 * and optionally a `readSnapshot` that reads one state: writes the hooks
 * make land before it opens, none during.
 */
const instrumented = (
  memory: DatabaseAdapter,
  { snapshots }: { readonly snapshots: boolean },
) => {
  const hooks: Hooks = {};
  const reads: { table: string; kind: "get" | "query" }[] = [];
  let snapshotsOpened = 0;
  const reader = (direct: boolean): SnapshotReader => ({
    async get(table, keys) {
      const rows = await memory.get(table, keys);
      reads.push({ kind: "get", table: table.name });
      if (direct) await hooks.afterRead?.(table.name, "get");
      return rows;
    },
    async query(table, request) {
      const rows = await memory.query(table, request);
      reads.push({ kind: "query", table: table.name });
      if (direct) await hooks.afterRead?.(table.name, "query");
      return rows;
    },
  });
  const adapter: DatabaseAdapter = Object.assign(
    Object.create(memory) as DatabaseAdapter,
    reader(true),
    snapshots
      ? {
          async readSnapshot<T>(read: (reader: SnapshotReader) => Promise<T>) {
            await hooks.beforeSnapshot?.();
            snapshotsOpened += 1;
            return read(reader(false));
          },
        }
      : {},
  );
  return {
    adapter,
    hooks,
    reads,
    snapshots: () => snapshotsOpened,
    reset: () => {
      reads.length = 0;
      snapshotsOpened = 0;
    },
  };
};

const policy = (
  targetAppVersion: string,
  extra: {
    readonly rolloutCohortCount?: number;
    readonly targetCohorts?: string[];
    readonly message?: string | null;
  } = {},
) => ({
  channel: CHANNEL,
  enabled: true,
  fingerprintHash: null,
  message: extra.message ?? null,
  shouldForceUpdate: false,
  targetAppVersion,
  ...(extra.rolloutCohortCount === undefined
    ? {}
    : { rolloutCohortCount: extra.rolloutCohortCount }),
  ...(extra.targetCohorts === undefined
    ? {}
    : { targetCohorts: extra.targetCohorts }),
});

/** A history of exact versions, ranges, rollouts and disabled releases. */
const MIXED: readonly [
  string,
  string,
  Parameters<typeof policy>[1]?,
  boolean?,
][] = [
  ["101", "1.0.0"],
  ["102", "1.0.0", { rolloutCohortCount: 400 }],
  ["103", ">=1.1.0 <2.0.0"],
  ["104", "2.0.0"],
  ["105", "1.x", { targetCohorts: ["qa"] }, false],
  ["106", "~1.2.0", { message: "hot fix" }],
  ["107", "3.0.0"],
  ["108", "2.0.0", { rolloutCohortCount: 0, targetCohorts: ["beta"] }],
  ["109", ">=3.0.0"],
  ["110", "1.2.3"],
];
/** A release for a history core's writer would refuse: 6 KB messages. */
const bigRelease = (sequence: number, targetAppVersion: string): Release =>
  ({
    bundleId: `00000000-0000-7001-8000-${String(sequence).padStart(12, "0")}`,
    channelId: "channel-big",
    createdAtMs: sequence,
    enabled: true,
    fingerprintHash: null,
    id: `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    kind: "BUNDLE",
    message: `${sequence}:${"m".repeat(6_000)}`,
    operation: "DEPLOY",
    platform: "ios",
    revision: 1,
    rolloutCohortCount: 1000,
    shouldForceUpdate: false,
    sourceReleaseId: null,
    strategy: "APP_VERSION",
    targetAppVersion,
    targetCohorts: [],
    updatedAtMs: sequence,
  }) as Release;

/** Exact versions only: a gap between each pair and at each end. */
const EXACT: readonly [string, string][] = [
  ["201", "1.0.0"],
  ["202", "1.0.0"],
  ["203", "2.0.0"],
  ["204", "4.1.0"],
];

const seed = async (
  core: CoreApi,
  history: readonly (readonly [
    string,
    string,
    Parameters<typeof policy>[1]?,
    boolean?,
  ])[],
  channel = CHANNEL,
) => {
  const ids: string[] = [];
  for (const [suffix, range, extra, enabled = true] of history) {
    const [deployed] = await core.deploy([
      {
        bundle: createBundleFixture(suffix),
        release: { ...policy(range, extra), channel },
      },
    ]);
    ids.push(deployed!.release!.id);
    if (!enabled) {
      await core.updateReleasePolicy({
        releaseId: deployed!.release!.id,
        patch: { enabled: false },
      });
    }
  }
  return ids;
};

const setup = async (
  history: Parameters<typeof seed>[1] = MIXED,
  { snapshots = false }: { readonly snapshots?: boolean } = {},
) => {
  const memory = createMemoryAdapter();
  const io = instrumented(memory, { snapshots });
  const core = createInProcessCoreApi(io.adapter);
  const ids = await seed(core, history);
  const fixture = createReleaseCatalogPartitionFixture(memory);
  /** A fresh server process: a handler with an empty memo. */
  const handlers = () => createHotUpdaterHandlers({ api: { core } });
  return { core, fixture, handlers, io, ids, memory };
};

const check = async (
  client: (request: Request) => Promise<Response>,
  appVersion: string,
  channel = CHANNEL,
) => {
  const response = await client(
    new Request(
      `http://localhost/release-catalogs/app-version/ios/${encodeChannelKey(channel)}/${appVersion}`,
    ),
  );
  return {
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
    marked: response.headers.get("x-hot-updater-catalog"),
    status: response.status,
  };
};

/** A stored row without one bundle's release, as a disable rewrites it. */
const withoutBundle = (
  partition: ReleaseCatalogPartition,
  bundleId: string,
): ReleaseCatalogPartition => {
  const catalog = JSON.parse(partition.payload);
  const kept: number[] = [];
  catalog.releaseDescriptors.forEach(
    (descriptor: { bundleId: string }, index: number) => {
      if (descriptor.bundleId !== bundleId) kept.push(index);
    },
  );
  const [segment] = catalog.segments;
  segment.releaseIndexes = segment.releaseIndexes
    .filter((index: number) => kept.includes(index))
    .map((index: number) => kept.indexOf(index));
  segment.rollbackReleaseIndexes = kept.map((_, index) => index);
  catalog.releaseDescriptors = kept.map(
    (index) => catalog.releaseDescriptors[index],
  );
  const payload = JSON.stringify(catalog);
  return {
    ...partition,
    byteSize: new TextEncoder().encode(payload).byteLength,
    payload,
  };
};

const releasesOf = async (core: CoreApi): Promise<Release[]> =>
  (
    await core.listReleases({
      filter: { kind: "scope", scopeKey: scopeKeyOf() },
      limit: 100,
    })
  ).map(releaseRowToRelease);

/**
 * Every probed version's answer and both selectors' decisions, compared
 * with `expected`: the answers today's compact row gave before the scope
 * was partitioned. Returns the mismatches, so a broken variant is seen red.
 */
const compareDecisions = (
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
  history: readonly Release[],
) => {
  const mismatches: string[] = [];
  const devices = deviceStates({
    builtInBundleId: "00000000-0000-0000-0000-000000000000",
    cohorts: cohortClasses(
      history.map((release) => ({
        releaseId: release.id,
        rolloutCohortCount: release.rolloutCohortCount,
        targetCohorts: release.targetCohorts,
      })),
    ),
    exhaustive: false,
    history,
    limit: 120,
    seed: 7,
  });
  let decisions = 0;
  for (const [version, want] of expected) {
    const got = actual.get(version);
    if (got !== want) mismatches.push(`answer ${version}`);
    if (got === undefined) continue;
    const [wantStatus, wantBody] = JSON.parse(want) as [number, string];
    const [gotStatus, gotBody] = JSON.parse(got) as [number, string];
    if (wantStatus !== 200 || gotStatus !== 200) continue;
    const wanted = JSON.parse(wantBody) as ReleaseCatalog;
    const answered = JSON.parse(gotBody) as ReleaseCatalog;
    for (const device of devices) {
      decisions += 1;
      if (
        decideReleaseCatalog(answered, device) !==
        decideReleaseCatalog(wanted, device)
      ) {
        mismatches.push(`decision ${version} ${JSON.stringify(device)}`);
        break;
      }
    }
  }
  return { decisions, mismatches };
};

const answersFor = async (
  client: (request: Request) => Promise<Response>,
  versions: readonly string[],
) => {
  const answers = new Map<string, string>();
  for (const version of versions) {
    const { status, body } = await check(client, version);
    answers.set(version, JSON.stringify([status, body]));
  }
  return answers;
};

const probesOf = (row: ReleaseCatalogRow, history: readonly Release[]) =>
  probeAppVersions(
    JSON.parse(row.payload),
    history.flatMap(({ targetAppVersion }) =>
      targetAppVersion === null ? [] : [targetAppVersion],
    ),
  );

describe.each([
  { name: "direct reads", snapshots: false },
  { name: "snapshot reads", snapshots: true },
])("partitioned release catalog reads ($name)", ({ snapshots }) => {
  it.each([
    { history: MIXED, name: "mixed ranges" },
    { history: EXACT, name: "exact versions with gaps" },
  ])(
    "answers every device as today's compact row did, both selectors, for $name",
    async ({ history }) => {
      const { core, fixture, handlers } = await setup(history, { snapshots });
      const compact = (await core.getReleaseCatalogRow(scopeKeyOf()))!;
      const releases = await releasesOf(core);
      const versions = probesOf(compact, releases);
      const before = await answersFor(handlers().client, versions);
      const plugin = new Map<string, string>();
      for (const version of [...versions, "not-a-version"]) {
        plugin.set(
          version,
          JSON.stringify(
            await core.getReleaseCatalog({
              appVersion: version,
              channelKey,
              platform: "ios",
              strategy: "APP_VERSION",
            }),
          ),
        );
      }

      await fixture.partition(scopeKeyOf());
      expect(await fixture.readRow(scopeKeyOf())).toMatchObject({
        catalog_hash: compact.catalog_hash,
        catalog_id: compact.catalog_id,
        generation: compact.generation,
      });

      const after = await answersFor(handlers().client, versions);
      const result = compareDecisions(before, after, releases);
      expect(result.mismatches).toEqual([]);
      expect(result.decisions).toBeGreaterThan(versions.length);
      // Core's own update check, as plugins read it; a version with no
      // canonical form gets today's empty lists without a row read.
      for (const version of [...versions, "not-a-version"]) {
        expect(
          JSON.stringify(
            await core.getReleaseCatalog({
              appVersion: version,
              channelKey,
              platform: "ios",
              strategy: "APP_VERSION",
            }),
          ),
          version,
        ).toBe(plugin.get(version));
      }

      // Red: the same comparison sees a partition that lost a descriptor.
      const rows = await fixture.rows(scopeKeyOf());
      const target = rows.find(
        (row) =>
          JSON.parse(row.partition.payload).releaseDescriptors.length > 0,
      )!;
      const broken = JSON.parse(target.partition.payload);
      broken.releaseDescriptors = broken.releaseDescriptors.slice(1);
      broken.segments[0].releaseIndexes = [];
      broken.segments[0].rollbackReleaseIndexes = [];
      const payload = JSON.stringify(broken);
      await fixture.deleteRows(scopeKeyOf(), [target]);
      await fixture.writeRows(scopeKeyOf(), [
        {
          ...target,
          partition: { ...target.partition, payload },
        },
      ]);
      const red = compareDecisions(
        before,
        await answersFor(handlers().client, versions),
        releases,
      );
      expect(red.mismatches).not.toEqual([]);
    },
    120_000,
  );

  it("serves a scope past today's 256 KB cap: every version as today's compiler projects it, and its compact row assembled", async () => {
    const { core, fixture, handlers } = await setup([], { snapshots });
    await seed(core, [["501", "0.0.1"]], "big");
    const created = await fixture.readRow(scopeKeyOf("big"));
    // 24 versions x 2 releases with 6 KB messages, and a broad range across
    // them: about 300 KB compact, refused today, every row well under 256 KB.
    const big = Array.from({ length: 49 }, (_, at) =>
      bigRelease(
        at + 1,
        at === 48 ? ">=5.0.0" : `${Math.floor(at / 2) + 1}.0.0`,
      ),
    );
    await expect(
      compileReleaseCatalog({ releases: big, strategy: "APP_VERSION" }),
    ).rejects.toMatchObject({ code: "CATALOG_OVERSIZE" });
    const tiling = (await compileReleaseCatalogTiling({ releases: big }))!;
    const epoch = crypto.randomUUID();
    await fixture.writeRows(
      scopeKeyOf("big"),
      tiling.map((partition) => ({
        epoch,
        generation: created.generation + 1,
        lowerKey: partition.lowerKey,
        partition,
      })),
    );
    await fixture.publishHead(scopeKeyOf("big"), {
      catalogHash: "sha256:big",
      epoch,
      generation: created.generation + 1,
    });
    const client = handlers().client;
    for (const version of [
      "0.0.1",
      "1.0.0",
      "4.5.0",
      "5.0.0",
      "12.0.0",
      "24.0.0",
      "30.0.0",
    ]) {
      // Today's compiler over the releases that reach this version: a
      // catalog under the cap, projected for it.
      const reaching = big.filter((release) =>
        semverSatisfies(release.targetAppVersion!, version),
      );
      const compiled = (
        await compileReleaseCatalog({
          releases: reaching,
          strategy: "APP_VERSION",
        })
      ).payload;
      const answer = await check(client, version, "big");
      expect(answer.status, version).toBe(200);
      expect(JSON.parse(answer.body), version).toMatchObject({
        catalogHash: "sha256:big",
        catalogId: created.catalog_id,
        generation: created.generation + 1,
        releases: projectCompiledCatalog(compiled, version),
        rollbackReleases: projectCompiledRollbackCatalog(compiled, version),
      });
    }
    const row = (await core.getReleaseCatalogRow(scopeKeyOf("big")))!;
    expect(row.byte_size).toBeGreaterThan(256 * 1024);
    expect(row).toEqual({
      ...created,
      byte_size: assembleReleaseCatalog(tiling).byteSize,
      catalog_hash: "sha256:big",
      generation: created.generation + 1,
      payload: assembleReleaseCatalog(tiling).canonicalPayload,
      updated_at_ms: row.updated_at_ms,
    });
    expect(await core.listReleaseCatalogs({ limit: 10 })).toContainEqual(row);
  });

  it("answers a gap with 200, the head's generation and empty lists, never the 404", async () => {
    const { core, fixture, handlers } = await setup(EXACT, { snapshots });
    const { compact } = await fixture.partition(scopeKeyOf());
    for (const version of ["0.9.0", "1.5.0", "3.0.0", "9.0.0"]) {
      const answer = await check(handlers().client, version);
      expect(answer.status, version).toBe(200);
      expect(answer.marked).toBeNull();
      expect(JSON.parse(answer.body)).toMatchObject({
        catalogHash: compact.catalog_hash,
        catalogId: compact.catalog_id,
        generation: compact.generation,
        releases: [],
        rollbackReleases: [],
      });
    }
    expect(await core.getReleaseCatalogRow(scopeKeyOf())).toEqual(compact);
  });

  it.each([
    { name: "missing", kind: "delete" },
    { name: "of a newer generation", kind: "newer" },
    { name: "corrupt", kind: "corrupt" },
  ] as const)(
    "answers a $name covering row with a retried, uncached 503, never the 404 or an empty catalog",
    async ({ kind }) => {
      const { fixture, handlers, io } = await setup(MIXED, { snapshots });
      const { rows } = await fixture.partition(scopeKeyOf());
      const client = handlers().client;
      const healthy = await check(client, "1.2.3");
      expect(healthy.status).toBe(200);
      // The row 1.2.3 reads: the greatest lower key at or below its key.
      const victim = rows.filter((row) => row.lowerKey <= "A1A2A3_=").at(-1)!;
      expect(victim).toBeDefined();
      await fixture.deleteRows(scopeKeyOf(), [victim]);
      if (kind !== "delete") {
        await fixture.writeRows(scopeKeyOf(), [
          kind === "newer"
            ? { ...victim, generation: victim.generation + 1 }
            : {
                ...victim,
                partition: { ...victim.partition, payload: "{" },
              },
        ]);
      }
      const fresh = handlers().client;
      io.reset();
      const failed = await check(fresh, "1.2.3");
      expect(failed.status).toBe(503);
      expect(failed.cacheControl).toBe("private, no-store");
      expect(failed.marked).toBeNull();
      expect(JSON.parse(failed.body)).toEqual({
        code: "CATALOG_SNAPSHOT_CONFLICT",
        error: "Service unavailable",
      });
      // Read again three times after the first.
      expect(
        io.reads.filter(({ table }) => table === "release_catalog_partitions"),
      ).toHaveLength(4);
      // Never cached: the repaired row answers at once.
      await fixture.deleteRows(scopeKeyOf(), [victim]);
      await fixture.writeRows(scopeKeyOf(), [victim]);
      expect((await check(fresh, "1.2.3")).body).toBe(healthy.body);
    },
  );

  it("reads a new version's row under the memo's cached head, and follows the head when its epoch was flipped and cleaned", async () => {
    const { fixture, handlers, io } = await setup(MIXED, { snapshots });
    const { compact, rows } = await fixture.partition(scopeKeyOf());
    const client = handlers().client;
    const first = await check(client, "1.0.0");
    expect(first.status).toBe(200);
    // 1.0.0's row is cached; 2.0.0 reads only its row under that head.
    io.reset();
    expect((await check(client, "2.0.0")).status).toBe(200);
    expect(io.reads.map(({ table }) => table)).toEqual(
      snapshots
        ? ["release_catalogs", "release_catalog_partitions"]
        : ["release_catalog_partitions"],
    );
    // A writer flips to a new epoch at G+1 and cleans the old one.
    const epoch = crypto.randomUUID();
    await fixture.writeRows(
      scopeKeyOf(),
      rows.map((row) => ({
        ...row,
        epoch,
        generation: compact.generation + 1,
      })),
    );
    await fixture.publishHead(scopeKeyOf(), {
      catalogHash: "sha256:flipped",
      epoch,
      generation: compact.generation + 1,
    });
    await fixture.deleteRows(scopeKeyOf(), rows);
    const next = await check(client, "3.0.0");
    expect(next.status).toBe(200);
    expect(JSON.parse(next.body)).toMatchObject({
      catalogHash: "sha256:flipped",
      generation: compact.generation + 1,
    });
    // The memo now holds the new head: 1.0.0 reads its row under it.
    const again = await check(client, "1.0.0");
    expect(JSON.parse(again.body)).toMatchObject({
      catalogHash: "sha256:flipped",
    });
    expect(JSON.parse(again.body).releases).toEqual(
      JSON.parse(first.body).releases,
    );
  });

  describe("a write between the head and its row", () => {
    const race = async (
      write: (
        context: Awaited<ReturnType<typeof setup>> & {
          readonly partitioned: Awaited<
            ReturnType<
              Awaited<ReturnType<typeof setup>>["fixture"]["partition"]
            >
          >;
        },
      ) => Promise<void>,
    ) => {
      const context = await setup(MIXED, { snapshots });
      const partitioned = await context.fixture.partition(scopeKeyOf());
      let fired = false;
      const once = async () => {
        if (fired) return;
        fired = true;
        await write({ ...context, partitioned });
      };
      if (snapshots) context.io.hooks.beforeSnapshot = once;
      else {
        context.io.hooks.afterRead = async (table) => {
          if (table === "release_catalogs") await once();
        };
      }
      const answer = await check(context.handlers().client, "1.2.3");
      context.io.hooks.afterRead = undefined;
      context.io.hooks.beforeSnapshot = undefined;
      expect(fired).toBe(true);
      return { ...context, answer, partitioned };
    };

    it("head to compact, with the old epoch cleaned: answers the compact row it reads next", async () => {
      const { answer, core, partitioned } = await race(
        async ({ fixture, partitioned }) => {
          await fixture.publishCompact(scopeKeyOf(), {
            catalogHash: "sha256:compact-next",
            generation: partitioned.compact.generation + 1,
            payload: partitioned.compact.payload,
          });
          await fixture.deleteRows(scopeKeyOf(), partitioned.rows);
        },
      );
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({
        catalogHash: "sha256:compact-next",
        generation: partitioned.compact.generation + 1,
      });
      expect((await core.getReleaseCatalogRow(scopeKeyOf()))!.payload).toBe(
        partitioned.compact.payload,
      );
    });

    it("head to compact, the old rows still stored: answers a committed state, the snapshot's own head with snapshots", async () => {
      const { answer, partitioned } = await race(
        async ({ fixture, partitioned }) => {
          await fixture.publishCompact(scopeKeyOf(), {
            catalogHash: "sha256:compact-next",
            generation: partitioned.compact.generation + 1,
            payload: partitioned.compact.payload,
          });
        },
      );
      expect(answer.status).toBe(200);
      // Without snapshots the row, stamped at G, is the head's content at
      // G, the state the head read saw. A snapshot read the compact row.
      expect(JSON.parse(answer.body)).toMatchObject(
        snapshots
          ? {
              catalogHash: "sha256:compact-next",
              generation: partitioned.compact.generation + 1,
            }
          : {
              catalogHash: partitioned.compact.catalog_hash,
              generation: partitioned.compact.generation,
            },
      );
    });

    it("an epoch flip that cleans the old epoch: answers the new head's row", async () => {
      const { answer, partitioned } = await race(
        async ({ fixture, partitioned }) => {
          const epoch = crypto.randomUUID();
          await fixture.writeRows(
            scopeKeyOf(),
            partitioned.rows.map((row) => ({
              ...row,
              epoch,
              generation: partitioned.compact.generation + 1,
            })),
          );
          await fixture.publishHead(scopeKeyOf(), {
            catalogHash: "sha256:head-next",
            epoch,
            generation: partitioned.compact.generation + 1,
          });
          await fixture.deleteRows(scopeKeyOf(), partitioned.rows);
        },
      );
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({
        catalogHash: "sha256:head-next",
        generation: partitioned.compact.generation + 1,
      });
    });

    it("the covering row rewritten in place at G+1: answers G+1, never G's head with G+1's row", async () => {
      const { answer, partitioned } = await race(
        async ({ fixture, partitioned }) => {
          const rows = await fixture.rows(scopeKeyOf());
          const covering = rows
            .filter((row) => row.lowerKey <= "A1A2A3_=")
            .at(-1)!;
          await fixture.publishHead(scopeKeyOf(), {
            catalogHash: "sha256:rewritten",
            epoch: partitioned.epoch,
            generation: partitioned.compact.generation + 1,
            remove: [covering],
            write: [
              { ...covering, generation: partitioned.compact.generation + 1 },
            ],
          });
        },
      );
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({
        catalogHash: "sha256:rewritten",
        generation: partitioned.compact.generation + 1,
      });
    });
  });

  it("lists and gets every scope as today's compact row, byte for byte, both orders, with writes between pages", async () => {
    const { core, fixture, io } = await setup(MIXED, { snapshots });
    await seed(core, EXACT, "beta");
    await seed(core, [["301", "5.0.0"]], "canary");
    const before = await core.listReleaseCatalogs({ limit: 10 });
    expect(before).toHaveLength(3);
    await fixture.partition(scopeKeyOf());
    await fixture.partition(scopeKeyOf("beta"));
    for (const order of ["asc", "desc"] as const) {
      const expected = order === "asc" ? before : [...before].reverse();
      const pages: ReleaseCatalogRow[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await core.listReleaseCatalogs({
          limit: 1,
          order,
          ...(after === undefined ? {} : { after }),
        });
        if (page.length === 0) break;
        pages.push(...page);
        after = page.at(-1)!.scope_key;
        // A write between pages that keeps every answer: canary converts
        // (compact to head), then beta's rows move to a new epoch at the
        // same generation. Each later page reads its own state.
        if (pages.length === 1 && order === "asc") {
          await fixture.partition(scopeKeyOf("canary"));
        }
        if (pages.length === 1 && order === "desc") {
          const beta = await fixture.readRow(scopeKeyOf("beta"));
          const old = await fixture.rows(scopeKeyOf("beta"));
          const epoch = crypto.randomUUID();
          await fixture.writeRows(
            scopeKeyOf("beta"),
            old.map((row) => ({ ...row, epoch })),
          );
          await fixture.publishHead(scopeKeyOf("beta"), {
            catalogHash: beta.catalog_hash,
            epoch,
            generation: beta.generation,
            remove: old,
          });
        }
      }
      expect(pages).toEqual(expected);
      for (const row of pages) {
        expect(await core.getReleaseCatalogRow(row.scope_key)).toEqual(row);
      }
    }
    // Snapshots read a page with heads again in one snapshot.
    io.reset();
    await core.listReleaseCatalogs({ limit: 10 });
    expect(io.snapshots()).toBe(snapshots ? 1 : 0);
  });

  it("assembles a scope another writer converted between the page and its snapshot (compact to head)", async () => {
    const { core, fixture, io } = await setup(MIXED, { snapshots });
    await seed(core, EXACT, "beta");
    const before = await core.listReleaseCatalogs({ limit: 10 });
    await fixture.partition(scopeKeyOf());
    let converted = false;
    const convert = async () => {
      if (converted) return;
      converted = true;
      await fixture.partition(scopeKeyOf("beta"));
    };
    if (snapshots) io.hooks.beforeSnapshot = convert;
    else {
      io.hooks.afterRead = async (table) => {
        if (table === "release_catalogs") await convert();
      };
    }
    expect(await core.listReleaseCatalogs({ limit: 10 })).toEqual(before);
    expect(converted).toBe(true);
  });

  it("assembles one generation when a write lands between the pages of a scope's rows", async () => {
    // 30 exact versions: 61 rows, two pages of 50.
    const history = Array.from(
      { length: 30 },
      (_, at) => [String(400 + at), `${at + 1}.0.0`] as [string, string],
    );
    const { core, fixture, io } = await setup(history, { snapshots });
    const { compact, epoch, rows } = await fixture.partition(scopeKeyOf());
    expect(rows.length).toBeGreaterThan(50);
    const before = await core.getReleaseCatalogRow(scopeKeyOf());
    expect(before).toEqual(compact);
    // The last row, on the second page, loses its release at G+1 (as a
    // disable rewrites it), with the head.
    const last = rows
      .filter(
        (row) =>
          JSON.parse(row.partition.payload).releaseDescriptors.length > 0,
      )
      .at(-1)!;
    const emptied = JSON.parse(last.partition.payload);
    emptied.releaseDescriptors = [];
    emptied.segments[0].releaseIndexes = [];
    emptied.segments[0].rollbackReleaseIndexes = [];
    let fired = false;
    const rewrite = async () => {
      if (fired) return;
      fired = true;
      await fixture.publishHead(scopeKeyOf(), {
        catalogHash: "sha256:disabled",
        epoch,
        generation: compact.generation + 1,
        remove: [last],
        write: [
          {
            ...last,
            generation: compact.generation + 1,
            partition: {
              ...last.partition,
              byteSize: new TextEncoder().encode(JSON.stringify(emptied))
                .byteLength,
              payload: JSON.stringify(emptied),
            },
          },
        ],
      });
    };
    if (snapshots) io.hooks.beforeSnapshot = rewrite;
    else {
      io.hooks.afterRead = async (table) => {
        if (table === "release_catalog_partitions") await rewrite();
      };
    }
    const during = await core.getReleaseCatalogRow(scopeKeyOf());
    io.hooks.afterRead = undefined;
    io.hooks.beforeSnapshot = undefined;
    expect(fired).toBe(true);
    // G+1's catalog: one release fewer, under G+1's identity.
    expect(during).toMatchObject({
      catalog_hash: "sha256:disabled",
      generation: compact.generation + 1,
    });
    expect(JSON.parse(during!.payload).releaseDescriptors).toHaveLength(29);
    expect(await core.getReleaseCatalogRow(scopeKeyOf())).toEqual(during);
  }, 60_000);

  it("finds the same patch bases as today's compact row for every range and limit", async () => {
    const { core, fixture } = await setup(MIXED, { snapshots });
    const ranges = [
      "1.0.0",
      "1.2.3",
      "1.5.0",
      "2.0.0",
      "3.0.0",
      "9.9.9",
      ">=1.0.0",
      "1.x",
      "~1.2.0",
      "*",
      ">=2.0.0 <3.0.0",
    ];
    const query = (range: string, limit: number, bundleId: string) =>
      core.findBaseBundleIds(
        targetBaseCandidateKey({
          appVersion: range,
          channel: CHANNEL,
          fingerprintHash: null,
          platform: "ios",
        })!,
        bundleId,
        limit,
      );
    const newest = createBundleFixture("999").id;
    const middle = createBundleFixture("106").id;
    const expected = new Map<string, string[]>();
    for (const range of ranges) {
      for (const limit of [1, 2, 11, 12, 100]) {
        for (const bundleId of [newest, middle]) {
          expected.set(
            JSON.stringify([range, limit, bundleId]),
            await query(range, limit, bundleId),
          );
        }
      }
    }
    expect([...expected.values()].some((ids) => ids.length > 1)).toBe(true);
    await fixture.partition(scopeKeyOf());
    for (const [key, ids] of expected) {
      const [range, limit, bundleId] = JSON.parse(key) as [
        string,
        number,
        string,
      ];
      expect(await query(range, limit, bundleId), key).toEqual(ids);
    }
  });

  it("never unions rows of two generations when a write lands between patch-base pages", async () => {
    const { core, fixture, io } = await setup(MIXED, { snapshots });
    const { compact, epoch } = await fixture.partition(scopeKeyOf());
    const key = targetBaseCandidateKey({
      appVersion: "*",
      channel: CHANNEL,
      fingerprintHash: null,
      platform: "ios",
    })!;
    const bundleId = createBundleFixture("999").id;
    const before = await core.findBaseBundleIds(key, bundleId, 100);
    // Between the first page (the last row) and the next, release 109
    // (">=3.0.0") is disabled at G+1: it leaves the last row, already read,
    // and the 3.0.0 row, read next. A union of both generations keeps it.
    const disabled = createBundleFixture("109").id;
    let fired = false;
    const rewrite = async () => {
      if (fired) return;
      fired = true;
      const holding = (await fixture.rows(scopeKeyOf())).filter(
        (row) =>
          row.epoch === epoch && row.partition.payload.includes(disabled),
      );
      expect(holding).toHaveLength(2);
      await fixture.publishHead(scopeKeyOf(), {
        catalogHash: "sha256:next",
        epoch,
        generation: compact.generation + 1,
        write: holding.map((row) => ({
          ...row,
          generation: compact.generation + 1,
          partition: withoutBundle(row.partition, disabled),
        })),
      });
    };
    if (snapshots) io.hooks.beforeSnapshot = rewrite;
    else {
      io.hooks.afterRead = async (table, kind) => {
        if (table === "release_catalog_partitions" && kind === "query") {
          await rewrite();
        }
      };
    }
    const during = await core.findBaseBundleIds(key, bundleId, 100);
    io.hooks.afterRead = undefined;
    io.hooks.beforeSnapshot = undefined;
    const settled = await core.findBaseBundleIds(key, bundleId, 100);
    expect(fired).toBe(true);
    expect(before).toContain(disabled);
    expect(settled).not.toContain(disabled);
    // G+1's union, read again; never G's rows with G+1's.
    expect(during).toEqual(settled);
  });

  it("refuses a patch-base union over a hole in the rows, as a retryable conflict", async () => {
    const { core, fixture } = await setup(MIXED, { snapshots });
    const { rows } = await fixture.partition(scopeKeyOf());
    const key = targetBaseCandidateKey({
      appVersion: "*",
      channel: CHANNEL,
      fingerprintHash: null,
      platform: "ios",
    })!;
    const bundleId = createBundleFixture("999").id;
    const before = await core.findBaseBundleIds(key, bundleId, 100);
    const middle = rows[Math.floor(rows.length / 2)]!;
    await fixture.deleteRows(scopeKeyOf(), [middle]);
    await expect(core.findBaseBundleIds(key, bundleId, 100)).rejects.toThrow(
      ReleaseCatalogReadConflictError,
    );
    const response = await createHotUpdaterHandlers({
      api: { core },
    }).admin(
      new Request(
        `http://localhost/base-candidates/${encodeURIComponent(key)}?${new URLSearchParams({ before: bundleId, limit: "100" })}`,
      ),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      code: "CATALOG_SNAPSHOT_CONFLICT",
    });
    await fixture.writeRows(scopeKeyOf(), [middle]);
    expect(await core.findBaseBundleIds(key, bundleId, 100)).toEqual(before);
  });

  describe("a patch-base range whose keys don't fit, read through every row", () => {
    // Its second endpoint compares through Number, so it has no key range.
    const UNENCODABLE = "<0.1.0 || >=1.0.0-9007199254740993";
    /** One release only the first row holds, one only a middle row, one only the last. */
    const EDGES: readonly [string, string][] = [
      ["301", "<0.0.5"],
      ["302", "~1.2.0"],
      ["303", "2.0.0"],
      ["304", "1.0.0"],
      ["305", ">=5.0.0"],
    ];
    const keyOf = () =>
      targetBaseCandidateKey({
        appVersion: UNENCODABLE,
        channel: CHANNEL,
        fingerprintHash: null,
        platform: "ios",
      })!;
    const bundleId = createBundleFixture("999").id;

    it.each([
      { history: MIXED, name: "mixed ranges" },
      { history: EDGES, name: "rows holding their own releases" },
    ])(
      "finds the same patch bases as today's compact row, for $name",
      async ({ history }) => {
        const { core, fixture } = await setup(history, { snapshots });
        const expected = await core.findBaseBundleIds(keyOf(), bundleId, 100);
        expect(expected.length).toBeGreaterThan(1);
        await fixture.partition(scopeKeyOf());
        expect(await core.findBaseBundleIds(keyOf(), bundleId, 100)).toEqual(
          expected,
        );
      },
    );

    const holding = (suffix: string) => {
      const id = createBundleFixture(suffix).id;
      return <T extends { partition: ReleaseCatalogPartition }>(
        rows: readonly T[],
      ) => rows.filter((row) => row.partition.payload.includes(id));
    };
    it.each([
      { name: "every row", pick: <T>(rows: readonly T[]) => [...rows] },
      { name: "a middle row", pick: holding("303") },
      { name: "the first row", pick: <T>(rows: readonly T[]) => [rows[0]!] },
      { name: "the last row", pick: <T>(rows: readonly T[]) => [rows.at(-1)!] },
    ])(
      "rereads, then refuses as a retryable conflict, when $name is missing",
      async ({ pick }) => {
        const { core, fixture, io } = await setup(EDGES, { snapshots });
        const before = await core.findBaseBundleIds(keyOf(), bundleId, 100);
        const { rows } = await fixture.partition(scopeKeyOf());
        const missing = pick(rows);
        expect(missing.length).toBeGreaterThan(0);
        // A base only the missing rows hold: a union of the rest omits it.
        const kept = rows.filter((row) => !missing.includes(row));
        expect(
          before.filter(
            (id) => !kept.some((row) => row.partition.payload.includes(id)),
          ),
        ).not.toEqual([]);
        await fixture.deleteRows(scopeKeyOf(), missing);
        io.reset();
        await expect(
          core.findBaseBundleIds(keyOf(), bundleId, 100),
        ).rejects.toThrow(ReleaseCatalogReadConflictError);
        // The first read and three rereads, each reading the head's rows.
        expect(
          io.reads.filter(
            ({ table }) => table === "release_catalog_partitions",
          ),
        ).toHaveLength(4);
        await fixture.writeRows(scopeKeyOf(), missing);
        expect(await core.findBaseBundleIds(keyOf(), bundleId, 100)).toEqual(
          before,
        );
      },
    );
  });

  it("reads 2 calls for a check, 2 for an exact-version patch base, none of the table for compact scopes, and ready() one raw row", async () => {
    const { core, fixture, handlers, io } = await setup(MIXED, { snapshots });
    io.reset();
    await check(handlers().client, "1.2.3");
    await core.findBaseBundleIds(
      targetBaseCandidateKey({
        appVersion: "1.2.3",
        channel: CHANNEL,
        fingerprintHash: null,
        platform: "ios",
      })!,
      createBundleFixture("999").id,
      5,
    );
    await core.getReleaseCatalogRow(scopeKeyOf());
    await core.listReleaseCatalogs({ limit: 5 });
    expect(io.reads.map(({ table }) => table)).not.toContain(
      "release_catalog_partitions",
    );
    expect(io.snapshots()).toBe(0);
    await fixture.partition(scopeKeyOf());
    io.reset();
    await check(handlers().client, "1.2.3");
    expect(io.reads).toHaveLength(snapshots ? 3 : 2);
    io.reset();
    await core.findBaseBundleIds(
      targetBaseCandidateKey({
        appVersion: "1.2.3",
        channel: CHANNEL,
        fingerprintHash: null,
        platform: "ios",
      })!,
      createBundleFixture("999").id,
      5,
    );
    expect(io.reads).toHaveLength(snapshots ? 3 : 2);
    io.reset();
    await core.ready();
    expect(io.reads).toEqual([{ kind: "query", table: "release_catalogs" }]);
  });
});
