import {
  compileReleaseCatalogTiling,
  createEngine,
  DatabaseAmbiguousCommitError,
  ReleaseCatalogMutationError,
  type WriteOp,
} from "@hot-updater/plugin-core";
import { encodeChannelKey, type Release } from "@hot-updater/protocol";
import {
  createBundleFixture,
  createReleaseCatalogPartitionFixture,
  setReleaseCatalogPartitioning,
} from "@hot-updater/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerCoreApi } from "./api";
import { cleanupStep, drainScope } from "./catalogWrites";
import {
  appVersionScope,
  createScopeOracle,
  createWriteTestAdapter,
  createWriteTestCore,
  fullCatalogOf,
  type PendingWrite,
  releasePolicy,
  releasesIn,
  storedScope,
} from "./catalogWrites.testFixtures";

const PARTITIONS = "release_catalog_partitions";
const SCOPE = appVersionScope("production");
const FIRST = "00000000-0000-4000-8000-000000000000";

/** The epoch column an op on the partition table names. */
const epochOf = (op: WriteOp) =>
  op.type === "insert" ? String(op.row.epoch) : String(op.key[1]);

/** Which step of a publication a write is. */
const kindOf = ({ ops }: PendingWrite) => {
  const partitionOps = ops.filter((op) => op.table.name === PARTITIONS);
  const rows = partitionOps.filter(
    (op) => op.type !== "check" && !["!", "#"].includes(epochOf(op)),
  );
  // A guard on the scope's row is a check; only a flip or an atomic write writes it.
  if (
    ops.some(
      (op) => op.table.name === "release_catalogs" && op.type !== "check",
    )
  ) {
    return rows.length === 0 ? "flip" : "atomic";
  }
  if (partitionOps.length === 0) return "other";
  if (ops.every((op) => op.type === "delete" || op.type === "check")) {
    return "cleanup";
  }
  if (
    partitionOps.some((op) => op.type === "insert" && epochOf(op) === "#") &&
    rows.length === 0
  ) {
    return "registration";
  }
  return "chunk";
};

const deploy = (
  core: ServerCoreApi,
  suffix: string,
  range: string,
  channel = "production",
) =>
  core.deploy([
    {
      bundle: createBundleFixture(suffix),
      release: releasePolicy(channel, range),
    },
  ]);

/**
 * A scope of exact versions, partitioned, on an adapter that stages every
 * publication bigger than `maxOps`, beside a second core over the same store
 * that commits anything atomically: the other writer.
 */
const setup = async ({ maxOps = 9, versions = 5, partitioned = true } = {}) => {
  const io = createWriteTestAdapter({ maxOps });
  const core = createWriteTestCore(io.adapter);
  const other = createWriteTestCore(io.memory);
  const db = createEngine({ name: "cleaner", adapter: io.memory }).core;
  if (partitioned) await setReleaseCatalogPartitioning(io.memory, "on");
  const ids: string[] = [];
  for (let index = 0; index < versions; index += 1) {
    const [deployed] = await deploy(
      other,
      `${100 + index}`,
      `${index + 1}.0.0`,
    );
    ids.push(deployed!.release!.id);
  }
  return { core, db, ids, io, other };
};

/** The oracle's verdict on the scope now: no mismatch, no broken invariant. */
const expectConsistent = async (
  core: ServerCoreApi,
  io: ReturnType<typeof createWriteTestAdapter>,
  scopeKey = SCOPE,
) => {
  const channel = scopeKey === SCOPE ? "production" : "beta";
  const oracle = createScopeOracle(channel);
  expect(await oracle.step(core, await releasesIn(core, scopeKey))).toEqual([]);
  expect((await storedScope(io.memory, scopeKey)).problems).toEqual([]);
};

/** Makes every write of `io` fail with an unknown outcome: the process died. */
const crash = (io: ReturnType<typeof createWriteTestAdapter>) => {
  io.hooks.beforeWrite = () => {
    throw new Error("the process died");
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ruling 2: a publication between computation and registration", () => {
  it.each([
    {
      name: "an edit",
      write: (core: ServerCoreApi, ids: string[]) =>
        core.updateReleasePolicy({
          patch: { targetAppVersion: "*" },
          releaseId: ids[0]!,
        }),
    },
    {
      name: "a rebuild",
      drift: true,
      write: async (core: ServerCoreApi) => {
        await core.rebuildReleaseCatalog(SCOPE);
      },
    },
    {
      compact: true,
      name: "a conversion",
      write: (core: ServerCoreApi) => deploy(core, "900", ">=1.0.0"),
    },
    {
      name: "a multi-scope write",
      write: async (core: ServerCoreApi, ids: string[]) => {
        await core.promoteRelease({
          action: "move",
          releaseId: ids[1]!,
          targetChannel: "beta",
        });
      },
    },
  ])(
    "$name computed at G and registered after G+1 computes again",
    async ({ write, drift = false, compact = false }) => {
      const { core, ids, io, other } = await setup({ partitioned: !compact });
      if (compact) await setReleaseCatalogPartitioning(io.memory, "on");
      if (drift) {
        // Stale rows, valid but without two releases: a rebuild rewrites them.
        const fixture = createReleaseCatalogPartitionFixture(io.memory);
        const stored = await storedScope(io.memory, SCOPE);
        const releases = await releasesIn(core, SCOPE);
        const { tiling } = await fullCatalogOf(
          releases.filter(({ id }) => id !== ids[0] && id !== ids[2]),
        );
        await fixture.publishHead(SCOPE, {
          catalogHash: stored.row!.catalog_hash,
          epoch: stored.liveEpoch!,
          generation: stored.row!.generation,
          remove: stored.live.map(({ lowerKey }) => ({
            epoch: stored.liveEpoch!,
            lowerKey,
          })),
          write: tiling!.map((partition) => ({
            epoch: stored.liveEpoch!,
            generation: stored.row!.generation,
            lowerKey: partition.lowerKey,
            partition,
          })),
        });
        io.setMaxOps(4);
      }
      let registrations = 0;
      let interleaved = false;
      io.hooks.beforeWrite = async (pending) => {
        if (kindOf(pending) !== "registration") return;
        registrations += 1;
        if (interleaved) return;
        interleaved = true;
        // Another writer publishes G+1: it disables a release the staged rows hold.
        await other.updateReleasePolicy({
          patch: { enabled: false },
          releaseId: ids[4]!,
        });
      };
      await write(core, ids);
      expect(interleaved).toBe(true);
      // The first registration found its base gone; the tiling was computed
      // again. A rebuild then finds the other writer already rewrote its rows.
      expect(registrations).toBeGreaterThanOrEqual(drift ? 1 : 2);
      const releases = await releasesIn(core, SCOPE);
      expect(releases.find(({ id }) => id === ids[4])!.enabled).toBe(false);
      await expectConsistent(core, io);
    },
  );
});

describe("ruling 3: cleanup always makes progress", () => {
  it("drains an unflippable epoch R names, keeps its marker, and reclaims the retired epochs behind it", async () => {
    const { core, db, io, other } = await setup();
    // Retired epochs: staged flips whose cleanup never ran.
    io.hooks.beforeWrite = (pending) => {
      if (kindOf(pending) === "cleanup") throw new Error("cleanup crashed");
    };
    await deploy(core, "200", "*");
    await deploy(core, "201", ">=2.0.0");
    const retired = (await storedScope(io.memory, SCOPE)).epochs;
    expect(retired.size).toBe(3);

    // A stager whose epoch sorts first stages its rows, then dies at its flip,
    // after an atomic writer published G+1: it can never flip.
    let sequence = 0;
    const spy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(
        () =>
          `${FIRST.slice(0, -4)}${String((sequence += 1)).padStart(4, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
      );
    io.hooks.beforeWrite = async (pending) => {
      const kind = kindOf(pending);
      if (kind === "cleanup") throw new Error("cleanup crashed");
      if (kind === "flip") {
        await deploy(other, "300", "1.0.0");
        crash(io);
        throw new Error("the process died");
      }
    };
    await expect(deploy(core, "202", ">=1.0.0 <3.0.0")).rejects.toThrow(
      DatabaseAmbiguousCommitError,
    );
    spy.mockRestore();
    io.hooks.beforeWrite = undefined;
    const before = await storedScope(io.memory, SCOPE);
    const paused = before.staging!.epoch!;
    // It sorts before every other epoch; the other writer's own cleanup step
    // already drained its rows, so its marker, which R names, sorts first.
    expect(paused.startsWith(FIRST.slice(0, -4))).toBe(true);
    expect([...before.markers].sort()[0]).toBe(paused);
    expect(before.markers.size).toBe(4);

    let steps = 0;
    while (await cleanupStep(db, SCOPE)) steps += 1;
    const after = await storedScope(io.memory, SCOPE);
    // Every retired epoch is gone, rows and markers; the one R names keeps its marker.
    expect([...after.epochs]).toEqual([after.liveEpoch]);
    expect([...after.markers].sort()).toEqual(
      [after.liveEpoch!, paused].sort(),
    );
    expect(steps).toBeGreaterThan(3);
    await expectConsistent(core, io);
  });

  it("reclaims the markers of registrations that crashed, one per step, inside the drain's budget", async () => {
    const { core, db, io } = await setup();
    const crashes = 7;
    for (let attempt = 0; attempt < crashes; attempt += 1) {
      // The process dies right after its registration commits: no drain, no chunk.
      io.hooks.afterWrite = (pending) => {
        if (kindOf(pending) !== "registration") return;
        crash(io);
        throw new Error("the process died");
      };
      await expect(deploy(core, `${400 + attempt}`, "*")).rejects.toThrow();
      io.hooks.beforeWrite = undefined;
    }
    io.hooks.afterWrite = undefined;
    const backlog = await storedScope(io.memory, SCOPE);
    // One marker per crashed registration, beside the live one.
    expect(backlog.markers.size).toBe(crashes + 1);
    expect(backlog.epochs.size).toBe(1);
    const steps = await drainScope(db, SCOPE);
    const after = await storedScope(io.memory, SCOPE);
    // R names the last crashed epoch: its marker stays; every other goes, one step each.
    expect(after.markers.size).toBe(2);
    expect(steps).toBe(crashes - 1);
    await deploy(core, "450", "*");
    await expectConsistent(core, io);
  });
});

describe("staged publications under other writers", () => {
  it("a paused stager above base 0 resumes after another publication: its chunk fails, and nothing lands", async () => {
    const { core, io, other } = await setup();
    let chunks = 0;
    let moved = false;
    io.hooks.beforeWrite = async (pending) => {
      if (kindOf(pending) !== "chunk") return;
      chunks += 1;
      if (moved) return;
      moved = true;
      await deploy(other, "500", "2.0.0");
    };
    await deploy(core, "501", "*");
    // The paused attempt's chunk was refused on the scope's row; a fresh one published.
    expect(chunks).toBeGreaterThanOrEqual(2);
    await expectConsistent(core, io);
  });

  it("a paused base-0 stager loses to a 1.2 first publication: its chunk fails on R", async () => {
    const io = createWriteTestAdapter({ maxOps: 9 });
    const core = createWriteTestCore(io.adapter);
    const other = createWriteTestCore(io.memory);
    await setReleaseCatalogPartitioning(io.memory, "on");
    let first = true;
    let lostOnR = false;
    io.hooks.beforeWrite = async (pending) => {
      if (kindOf(pending) !== "chunk" || !first) return;
      first = false;
      await deploy(other, "600", "1.0.0");
      const stored = await storedScope(io.memory, SCOPE);
      // Rule W: the first publication reset R.
      lostOnR = stored.staging?.epoch === null;
    };
    await deploy(core, "601", ">=2.0.0 <3.0.0");
    expect(lostOnR).toBe(true);
    await expectConsistent(core, io);
  });

  it("a paused base-0 stager loses to a released writer's creation: the flip fails, late rows are reclaimed", async () => {
    const io = createWriteTestAdapter({ maxOps: 9 });
    const core = createWriteTestCore(io.adapter);
    const released = createWriteTestCore(io.memory);
    const db = createEngine({ name: "cleaner", adapter: io.memory }).core;
    await setReleaseCatalogPartitioning(io.memory, "on");
    let created = false;
    io.hooks.beforeWrite = async (pending) => {
      if (kindOf(pending) !== "chunk" || created) return;
      created = true;
      // A released writer creates the row compact, and never writes R.
      await setReleaseCatalogPartitioning(io.memory, "off");
      await deploy(released, "700", "1.0.0");
      await setReleaseCatalogPartitioning(io.memory, "on");
      // Cleanup runs before the late chunk: R still names the empty epoch,
      // so its marker stays (rule E), and the chunk's rows stay discoverable.
      await drainScope(db, SCOPE);
    };
    await deploy(core, "701", ">=2.0.0 <3.0.0");
    expect(created).toBe(true);
    await drainScope(db, SCOPE);
    const stored = await storedScope(io.memory, SCOPE);
    expect([...stored.epochs]).toEqual(
      stored.liveEpoch === null ? [] : [stored.liveEpoch],
    );
    await expectConsistent(core, io);
  });

  it("a stager whose epoch another registration superseded, and whose rows that one drained, never flips", async () => {
    const { core, io } = await setup();
    const rival = createWriteTestAdapter({ maxOps: 9, memory: io.memory });
    const rivalCore = createWriteTestCore(rival.adapter);
    let flips = 0;
    io.hooks.beforeWrite = async (pending) => {
      if (kindOf(pending) !== "flip" || flips++ > 0) return;
      // Before the flip: a rival registers (R moves on), drains the epoch it
      // superseded, and dies at its first chunk.
      rival.hooks.beforeWrite = (write) => {
        if (kindOf(write) === "chunk") throw new Error("the rival died");
      };
      await expect(deploy(rivalCore, "1050", ">=2.0.0")).rejects.toThrow();
    };
    await deploy(core, "1051", "*");
    expect(flips).toBeGreaterThanOrEqual(2);
    await expectConsistent(core, io);
  });

  it("two live stagers supersede each other; one publishes, never a partial tiling", async () => {
    const { core, io } = await setup();
    const second = createWriteTestCore(io.adapter);
    const results = await Promise.allSettled([
      deploy(core, "800", "*"),
      deploy(second, "801", ">=2.0.0"),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ReleaseCatalogMutationError);
        expect((result.reason as ReleaseCatalogMutationError).code).toBe(
          "CATALOG_PUBLICATION_CONFLICT",
        );
      }
    }
    expect(results.some(({ status }) => status === "fulfilled")).toBe(true);
    await expectConsistent(core, io);
  });

  it("gives up after 5 restarts with the retryable conflict, publishing nothing", async () => {
    const { core, io, other } = await setup();
    const before = await storedScope(io.memory, SCOPE);
    let stolen = 0;
    io.hooks.beforeWrite = async (pending) => {
      if (kindOf(pending) !== "chunk") return;
      stolen += 1;
      await deploy(other, `${900 + stolen}`, "4.0.0");
    };
    const error = await deploy(core, "899", "*").catch((caught) => caught);
    expect(error).toBeInstanceOf(ReleaseCatalogMutationError);
    expect(error.code).toBe("CATALOG_PUBLICATION_CONFLICT");
    expect(stolen).toBe(5);
    io.hooks.beforeWrite = undefined;
    const releases = await releasesIn(core, SCOPE);
    expect(releases.some((release) => release.targetAppVersion === "*")).toBe(
      false,
    );
    expect((await storedScope(io.memory, SCOPE)).row!.generation).toBe(
      before.row!.generation + 5,
    );
    await expectConsistent(core, io);
  });

  it("concurrent cleaners keep every row discoverable", async () => {
    const { core, db, io } = await setup();
    io.hooks.beforeWrite = (pending) => {
      if (kindOf(pending) === "cleanup") throw new Error("cleanup crashed");
    };
    for (let index = 0; index < 4; index += 1) {
      await deploy(core, `${1000 + index}`, index % 2 ? "*" : ">=1.0.0");
    }
    io.hooks.beforeWrite = undefined;
    await Promise.all([
      drainScope(db, SCOPE),
      drainScope(db, SCOPE),
      drainScope(createEngine({ name: "b", adapter: io.memory }).core, SCOPE),
    ]);
    const stored = await storedScope(io.memory, SCOPE);
    expect([...stored.epochs]).toEqual([stored.liveEpoch]);
    await expectConsistent(core, io);
  });
});

describe("ambiguous commits", () => {
  it("a registration with an unknown outcome registers again with a fresh epoch", async () => {
    const { core, io } = await setup();
    const epochs: string[] = [];
    io.hooks.afterWrite = (pending) => {
      if (kindOf(pending) !== "registration") return;
      const marker = pending.ops.find(
        (op) => op.type === "insert" && epochOf(op) === "#",
      ) as Extract<WriteOp, { type: "insert" }>;
      epochs.push(String(marker.row.lower_key));
      if (epochs.length === 1) throw new Error("the connection dropped");
    };
    await deploy(core, "1100", "*");
    expect(epochs.length).toBe(2);
    expect(epochs[0]).not.toBe(epochs[1]);
    await expectConsistent(core, io);
  });

  it("a chunk that committed with an unknown outcome is read back, not written twice", async () => {
    const { core, io } = await setup();
    let dropped = false;
    io.hooks.afterWrite = (pending) => {
      if (kindOf(pending) !== "chunk" || dropped) return;
      dropped = true;
      throw new Error("the connection dropped");
    };
    await deploy(core, "1200", "*");
    expect(dropped).toBe(true);
    await expectConsistent(core, io);
  });

  it.each([
    { committed: true, name: "committed" },
    { committed: false, name: "did not commit" },
  ])(
    "a flip whose outcome is unknown ($name) publishes exactly once",
    async ({ committed }) => {
      const { core, io } = await setup();
      const before = (await storedScope(io.memory, SCOPE)).row!.generation;
      let dropped = false;
      const fail = (pending: PendingWrite) => {
        if (kindOf(pending) !== "flip" || dropped) return;
        dropped = true;
        throw new Error("the connection dropped");
      };
      if (committed) io.hooks.afterWrite = fail;
      else io.hooks.beforeWrite = fail;
      const [result] = await deploy(core, "1300", "*");
      expect(dropped).toBe(true);
      const stored = await storedScope(io.memory, SCOPE);
      expect(stored.row!.generation).toBe(before + 1);
      expect(result!.catalog.generation).toBe(before + 1);
      await expectConsistent(core, io);
    },
  );
});

describe("limits", () => {
  it("first publication staged and killed before its flip leaves no catalog: the marked 404", async () => {
    const io = createWriteTestAdapter({ maxOps: 9 });
    const core = createWriteTestCore(io.adapter);
    await setReleaseCatalogPartitioning(io.memory, "on");
    let staged = false;
    io.hooks.beforeWrite = (pending) => {
      if (kindOf(pending) === "chunk") staged = true;
      if (kindOf(pending) === "flip") throw new Error("the process died");
    };
    await expect(deploy(core, "1401", ">=1.0.0 <2.0.0")).rejects.toThrow();
    expect(staged).toBe(true);
    expect(await core.getReleaseCatalogRow(SCOPE)).toBeNull();
    expect(await releasesIn(core, SCOPE)).toEqual([]);
    const { client } = (await import("../handler")).createHotUpdaterHandlers({
      api: { core },
    });
    const response = await client(
      new Request(
        `http://localhost/release-catalogs/app-version/ios/${encodeChannelKey("production")}/1.0.0`,
      ),
    );
    expect(response.status).toBe(404);
  });

  it("refuses a write past the last safe generation, writing nothing", async () => {
    const { core, io } = await setup();
    const stored = await storedScope(io.memory, SCOPE);
    const fixture = createReleaseCatalogPartitionFixture(io.memory);
    await fixture.publishHead(SCOPE, {
      catalogHash: stored.row!.catalog_hash,
      epoch: stored.liveEpoch!,
      generation: Number.MAX_SAFE_INTEGER,
    });
    const rowsBefore = await fixture.rows(SCOPE);
    for (const range of ["1.0.0", "*"]) {
      const error = await deploy(core, "1500", range).catch((caught) => caught);
      expect(error).toBeInstanceOf(ReleaseCatalogMutationError);
      expect(error.code).toBe("CATALOG_GENERATION_EXHAUSTED");
    }
    expect(await fixture.rows(SCOPE)).toEqual(rowsBefore);
  });

  it("keeps a partitioned scope over 256 KB partitioned when the switch row is gone (downgrade guard)", async () => {
    const { core, io } = await setup({ maxOps: Number.POSITIVE_INFINITY });
    const message = "m".repeat(6_000);
    for (let index = 0; index < 50; index += 1) {
      await core.deploy([
        {
          bundle: createBundleFixture(`${1600 + index}`),
          release: releasePolicy("production", `${(index % 12) + 1}.0.0`, {
            message: `${index}:${message}`,
          }),
        },
      ]);
    }
    await setReleaseCatalogPartitioning(io.memory, "off");
    await deploy(core, "1700", "3.0.0");
    const row = await core.getReleaseCatalogRow(SCOPE);
    expect(row!.byte_size).toBeGreaterThan(256 * 1024);
    expect((await storedScope(io.memory, SCOPE)).liveEpoch).not.toBeNull();
    await expectConsistent(core, io);
  });

  it("writes compact again when every release is disabled, and when a key doesn't fit", async () => {
    const { core, ids, io } = await setup({ maxOps: Number.POSITIVE_INFINITY });
    for (const id of ids) {
      await core.updateReleasePolicy({
        patch: { enabled: false },
        releaseId: id,
      });
    }
    let stored = await storedScope(io.memory, SCOPE);
    expect(stored.liveEpoch).toBeNull();
    expect(stored.row!.is_tombstone).toBe(true);
    await core.updateReleasePolicy({
      patch: { enabled: true },
      releaseId: ids[0]!,
    });
    expect((await storedScope(io.memory, SCOPE)).liveEpoch).not.toBeNull();
    // A 250-character prerelease endpoint has no partition key: compact, as today.
    await deploy(core, "1800", `1.0.0-${"a".repeat(250)}`);
    stored = await storedScope(io.memory, SCOPE);
    expect(stored.liveEpoch).toBeNull();
    await expectConsistent(core, io);
  });

  it("a rebuild of an unchanged partitioned scope writes nothing", async () => {
    const { core, io } = await setup();
    const writes = io.writes.length;
    const result = await core.rebuildReleaseCatalog(SCOPE);
    expect(result.changed).toBe(false);
    expect(io.writes.length).toBe(writes);
    const preflight = await core.preflightReleaseCatalogRebuild(SCOPE);
    expect(preflight.changed).toBe(false);
    expect(preflight.currentCatalog!.payload).not.toContain('"layout"');
  });

  it("optional cleanup that fails after a successful flip never fails the write", async () => {
    const { core, io } = await setup();
    io.hooks.beforeWrite = (pending) => {
      if (kindOf(pending) === "cleanup") throw new Error("cleanup crashed");
    };
    await deploy(core, "1900", "*");
    io.hooks.beforeWrite = undefined;
    await expectConsistent(core, io);
  });
});

describe("snapshot reads", () => {
  it("a publication between the transaction's head read and its snapshot reruns the write", async () => {
    const io = createWriteTestAdapter({
      maxOps: Number.POSITIVE_INFINITY,
      snapshots: true,
    });
    const core = createWriteTestCore(io.adapter);
    const other = createWriteTestCore(io.memory);
    await setReleaseCatalogPartitioning(io.memory, "on");
    for (let index = 0; index < 4; index += 1) {
      await deploy(other, `${2000 + index}`, `${index + 1}.0.0`);
    }
    // The writer's first snapshot waits while another process publishes:
    // after the transaction read the head, before the snapshot reads it.
    let interleaved = false;
    let reached!: () => void;
    const atSnapshot = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let proceed!: () => void;
    const released = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    io.hooks.beforeSnapshot = async () => {
      if (interleaved) return;
      interleaved = true;
      reached();
      await released;
    };
    const before = io.snapshotsOpened();
    const writing = deploy(core, "2101", "2.0.0");
    await atSnapshot;
    await deploy(other, "2100", "2.0.0");
    proceed();
    await writing;
    expect(interleaved).toBe(true);
    // The first snapshot found another head; the write read again.
    expect(io.snapshotsOpened() - before).toBeGreaterThanOrEqual(2);
    expect(
      (await releasesIn(core, SCOPE)).filter(
        (release) => release.targetAppVersion === "2.0.0",
      ),
    ).toHaveLength(3);
    await expectConsistent(core, io);
  });
});

/** A release whose 1.0.0-free interval row holds only it, with `message` bytes of message. */
const releaseOf = (version: string, message: string): Release =>
  ({
    bundleId: createBundleFixture("3000").id,
    channelId: "channel:x",
    createdAtMs: 0,
    enabled: true,
    fingerprintHash: null,
    id: "01900000-0000-7000-8000-000000000000",
    kind: "BUNDLE",
    message,
    operation: "DEPLOY",
    platform: "ios",
    revision: 1,
    rolloutCohortCount: 1000,
    shouldForceUpdate: false,
    sourceReleaseId: null,
    strategy: "APP_VERSION",
    targetAppVersion: version,
    targetCohorts: [],
    updatedAtMs: 0,
  }) as Release;

/** The message length that makes `version`'s row exactly `bytes` long. */
const messageFor = async (version: string, bytes: number) => {
  const tiling = await compileReleaseCatalogTiling({
    releases: [releaseOf(version, "m")],
  });
  const row = tiling!.find(({ payload }) => payload.includes('"m"'))!;
  return 1 + bytes - row.byteSize;
};

describe("the per-partition caps: 256 KB and 512 cohorts, refused atomically naming the interval", () => {
  it.each([
    { maxOps: Number.POSITIVE_INFINITY, name: "atomic" },
    { maxOps: 9, name: "staged" },
  ])(
    "$name: a 262,144-byte row is written, a 262,145-byte one refused with nothing written",
    async ({ maxOps }) => {
      const { core, io } = await setup({ maxOps });
      const fits = await messageFor("9.0.0", 262_144);
      await core.deploy([
        {
          bundle: createBundleFixture("3001"),
          release: releasePolicy("production", "9.0.0", {
            message: "m".repeat(fits),
          }),
        },
      ]);
      const stored = await storedScope(io.memory, SCOPE);
      expect(Math.max(...stored.live.map(({ byteSize }) => byteSize))).toBe(
        262_144,
      );
      const rows = await createReleaseCatalogPartitionFixture(io.memory).rows(
        SCOPE,
      );
      const over = await messageFor("10.0.0", 262_145);
      const error = await core
        .deploy([
          {
            bundle: createBundleFixture("3002"),
            release: releasePolicy("production", "10.0.0", {
              message: "m".repeat(over),
            }),
          },
        ])
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "CATALOG_OVERSIZE" });
      expect(String((error as Error).message)).toContain("10.0.0");
      expect(
        await createReleaseCatalogPartitionFixture(io.memory).rows(SCOPE),
      ).toEqual(rows);
      expect(
        (await releasesIn(core, SCOPE)).some(
          (release) => release.targetAppVersion === "10.0.0",
        ),
      ).toBe(false);
      await expectConsistent(core, io);
    },
  );

  it("512 distinct cohorts in one interval are written; the 513th is refused naming it", async () => {
    const { core, io } = await setup({ maxOps: Number.POSITIVE_INFINITY });
    const cohorts = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `c${from + index}`);
    let next = 0;
    for (const [index, count] of [100, 100, 100, 100, 100, 12].entries()) {
      await core.deploy([
        {
          bundle: createBundleFixture(`${3100 + index}`),
          release: releasePolicy("production", "9.0.0", {
            targetCohorts: cohorts(next, count),
          }),
        },
      ]);
      next += count;
    }
    const error = await core
      .deploy([
        {
          bundle: createBundleFixture("3199"),
          release: releasePolicy("production", "9.0.0", {
            targetCohorts: cohorts(next, 1),
          }),
        },
      ])
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "DISTINCT_TARGET_COHORT_LIMIT" });
    expect(String((error as Error).message)).toContain("9.0.0");
    // Another interval takes its own 512.
    await core.deploy([
      {
        bundle: createBundleFixture("3200"),
        release: releasePolicy("production", "8.0.0", {
          targetCohorts: cohorts(1000, 100),
        }),
      },
    ]);
    await expectConsistent(core, io);
  });
});

describe("preflights answer public rows and write nothing", () => {
  it.each([
    { name: "a partitioned scope", converting: false },
    { name: "a compact scope with the switch on", converting: true },
  ])(
    "a policy preflight of $name projects exactly what the write publishes",
    async ({ converting }) => {
      const { core, ids, io } = await setup({
        maxOps: Number.POSITIVE_INFINITY,
        partitioned: !converting,
      });
      if (converting) await setReleaseCatalogPartitioning(io.memory, "on");
      const current = await core.getReleaseCatalogRow(SCOPE);
      const writes = io.writes.length;
      const patch = { targetAppVersion: ">=1.0.0 <4.0.0" };
      const preflight = await core.preflightReleasePolicy({
        patch,
        releaseId: ids[1]!,
      });
      expect(io.writes.length).toBe(writes);
      expect(preflight.currentCatalog).toEqual(current);
      expect(preflight.catalog.payload).not.toContain('"layout"');
      await core.updateReleasePolicy({ patch, releaseId: ids[1]! });
      const after = await core.getReleaseCatalogRow(SCOPE);
      expect(preflight.catalog.payload).toBe(after!.payload);
      expect(preflight.catalog.generation).toBe(after!.generation);
      expect((await storedScope(io.memory, SCOPE)).liveEpoch).not.toBeNull();
    },
  );

  it("a rebuild preflight of drifted rows says changed, and projects what the rebuild publishes", async () => {
    const { core, ids, io } = await setup({ maxOps: Number.POSITIVE_INFINITY });
    const fixture = createReleaseCatalogPartitionFixture(io.memory);
    const stored = await storedScope(io.memory, SCOPE);
    const { tiling } = await fullCatalogOf(
      (await releasesIn(core, SCOPE)).filter(({ id }) => id !== ids[0]),
    );
    await fixture.publishHead(SCOPE, {
      catalogHash: stored.row!.catalog_hash,
      epoch: stored.liveEpoch!,
      generation: stored.row!.generation,
      remove: stored.live.map(({ lowerKey }) => ({
        epoch: stored.liveEpoch!,
        lowerKey,
      })),
      write: tiling!.map((partition) => ({
        epoch: stored.liveEpoch!,
        generation: stored.row!.generation,
        lowerKey: partition.lowerKey,
        partition,
      })),
    });
    const current = await core.getReleaseCatalogRow(SCOPE);
    const writes = io.writes.length;
    const preflight = await core.preflightReleaseCatalogRebuild(SCOPE);
    expect(io.writes.length).toBe(writes);
    expect(preflight.changed).toBe(true);
    expect(preflight.currentCatalog).toEqual(current);
    const rebuilt = await core.rebuildReleaseCatalog(SCOPE);
    expect(rebuilt.changed).toBe(true);
    const after = await core.getReleaseCatalogRow(SCOPE);
    expect(preflight.projectedCatalog.payload).toBe(after!.payload);
    expect(preflight.projectedCatalog.generation).toBe(after!.generation);
  });

  it("a compact scope with the switch on is not stale to doctor: preflight judges its content", async () => {
    const { core, io } = await setup({ partitioned: false });
    await setReleaseCatalogPartitioning(io.memory, "on");
    const preflight = await core.preflightReleaseCatalogRebuild(SCOPE);
    expect(preflight.changed).toBe(false);
  });
});

describe("staged results carry every field the atomic path returns", () => {
  /** A drifted partitioned scope on an adapter staging past `maxOps`. */
  const drifted = async (maxOps: number) => {
    const { core, ids, io } = await setup({ maxOps });
    const fixture = createReleaseCatalogPartitionFixture(io.memory);
    const stored = await storedScope(io.memory, SCOPE);
    const { tiling } = await fullCatalogOf(
      (await releasesIn(core, SCOPE)).filter(
        ({ id }) => id !== ids[0] && id !== ids[2],
      ),
    );
    await fixture.publishHead(SCOPE, {
      catalogHash: stored.row!.catalog_hash,
      epoch: stored.liveEpoch!,
      generation: stored.row!.generation,
      remove: stored.live.map(({ lowerKey }) => ({
        epoch: stored.liveEpoch!,
        lowerKey,
      })),
      write: tiling!.map((partition) => ({
        epoch: stored.liveEpoch!,
        generation: stored.row!.generation,
        lowerKey: partition.lowerKey,
        partition,
      })),
    });
    return { core, io };
  };

  it("a staged rebuild answers the diagnostics an atomic one does, through core and the admin route", async () => {
    const atomic = await drifted(Number.POSITIVE_INFINITY);
    const staged = await drifted(4);
    const expected = await atomic.core.rebuildReleaseCatalog(SCOPE);
    let flips = 0;
    staged.io.hooks.beforeWrite = (pending) => {
      if (kindOf(pending) === "flip") flips += 1;
    };
    const result = await staged.core.rebuildReleaseCatalog(SCOPE);
    expect(flips).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.diagnostics).toEqual(expected.diagnostics);
    expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());

    // Through the admin route, as a remote CLI reads it.
    const again = await drifted(4);
    const { createAdminRouteHandlers } = await import("../handlerAdminRoutes");
    const response = await createAdminRouteHandlers().rebuildReleaseCatalog!(
      { scopeKey: encodeURIComponent(SCOPE) },
      new Request(
        `http://localhost/release-catalogs/${encodeURIComponent(SCOPE)}/rebuild`,
        { method: "POST" },
      ),
      { core: again.core } as never,
    );
    const body = (await response.json()) as {
      data: { diagnostics: unknown; changed: boolean };
    };
    expect(body.data.changed).toBe(true);
    expect(body.data.diagnostics).toEqual(expected.diagnostics);
  });

  it("a staged edit answers the diagnostics and release an atomic one does", async () => {
    const results: Awaited<ReturnType<ServerCoreApi["updateReleasePolicy"]>>[] =
      [];
    const flips: number[] = [];
    for (const maxOps of [Number.POSITIVE_INFINITY, 4]) {
      const { core, ids, io } = await setup({ maxOps });
      let flipped = 0;
      io.hooks.beforeWrite = (pending) => {
        if (kindOf(pending) === "flip") flipped += 1;
      };
      results.push(
        await core.updateReleasePolicy({
          patch: { targetAppVersion: "*" },
          releaseId: ids[0]!,
        }),
      );
      flips.push(flipped);
    }
    // The first committed atomically; the second staged and flipped once.
    expect(flips).toEqual([0, 1]);
    const [atomic, staged] = results;
    // The two databases differ in IDs and clocks; every field is present
    // in both, and the release's policy is the same.
    expect(Object.keys(staged!).sort()).toEqual(Object.keys(atomic!).sort());
    const policy = (release: (typeof results)[number]["release"]) => ({
      enabled: release!.enabled,
      revision: release!.revision,
      target: release!.target_app_version,
    });
    expect(policy(staged!.release)).toEqual(policy(atomic!.release));
    expect(Object.keys(staged!.release!).sort()).toEqual(
      Object.keys(atomic!.release!).sort(),
    );
    expect(Object.keys(staged!.catalog).sort()).toEqual(
      Object.keys(atomic!.catalog).sort(),
    );
  });
});

describe("a store's per-request query cap (maxQueriesPerRequest)", () => {
  /** The setup's scope on an adapter declaring `budget`, with every staged count reported. */
  const capped = async (budget: number) => {
    const io = createWriteTestAdapter({ maxOps: 9 });
    const memory = io.memory;
    const adapter = Object.assign(Object.create(io.adapter), {
      maxQueriesPerRequest: budget,
    });
    const counts: { needed: number; budget: number }[] = [];
    const core = createWriteTestCore(adapter, {
      catalogWrites: {
        onStagingBudget: (count) => counts.push(count),
        restartDelay: async () => {},
      },
    });
    const other = createWriteTestCore(memory);
    await setReleaseCatalogPartitioning(memory, "on");
    for (let index = 0; index < 5; index += 1) {
      await deploy(other, `${4000 + index}`, `${index + 1}.0.0`);
    }
    let flips = 0;
    io.hooks.beforeWrite = (pending) => {
      if (kindOf(pending) === "flip") flips += 1;
    };
    return { core, counts, flips: () => flips, io };
  };

  it("stages a publication counted at the cap, and writes today's compact row one query over it", async () => {
    // The count of one staged broad insert, with room to spare.
    const probe = await capped(10_000);
    await deploy(probe.core, "4100", "*");
    expect(probe.flips()).toBe(1);
    const needed = probe.counts.at(-1)!.needed;

    for (const [budget, stages] of [
      [needed + 1, true],
      [needed, true],
      [needed - 1, false],
    ] as const) {
      const run = await capped(budget);
      const before = (await storedScope(run.io.memory, SCOPE)).liveEpoch;
      await deploy(run.core, "4100", "*");
      expect(run.counts.at(-1)).toEqual({ budget, needed });
      const stored = await storedScope(run.io.memory, SCOPE);
      // At the cap a staged flip names a new epoch; over it the scope is a
      // compact row, as today. Both answer every device the same.
      if (stages) {
        expect(stored.liveEpoch).not.toBeNull();
        expect(stored.liveEpoch).not.toBe(before);
      } else {
        expect(stored.liveEpoch).toBeNull();
      }
      await expectConsistent(run.core, run.io);
    }
  });

  it("refuses exactly as today when the compact row wouldn't fit 256 KB", async () => {
    const run = await capped(30);
    const message = "m".repeat(6_000);
    // Partitioned past 256 KB through an uncapped writer.
    const other = createWriteTestCore(run.io.memory);
    for (let index = 0; index < 50; index += 1) {
      await other.deploy([
        {
          bundle: createBundleFixture(`${4200 + index}`),
          release: releasePolicy("production", `${(index % 12) + 1}.0.0`, {
            message: `${index}:${message}`,
          }),
        },
      ]);
    }
    const before = await storedScope(run.io.memory, SCOPE);
    const error = await deploy(run.core, "4300", "*").catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "CATALOG_OVERSIZE" });
    const after = await storedScope(run.io.memory, SCOPE);
    expect(after.row!.generation).toBe(before.row!.generation);
    expect(after.liveEpoch).toBe(before.liveEpoch);
  });

  it("a store with no cap stages as before, whatever the count", async () => {
    const io = createWriteTestAdapter({ maxOps: 9 });
    const counts: unknown[] = [];
    const core = createWriteTestCore(io.adapter, {
      catalogWrites: { onStagingBudget: (count) => counts.push(count) },
    });
    const other = createWriteTestCore(io.memory);
    await setReleaseCatalogPartitioning(io.memory, "on");
    for (let index = 0; index < 5; index += 1) {
      await deploy(other, `${4400 + index}`, `${index + 1}.0.0`);
    }
    await deploy(core, "4500", "*");
    expect(counts).toEqual([]);
    expect((await storedScope(io.memory, SCOPE)).liveEpoch).not.toBeNull();
  });
});
