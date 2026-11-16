import {
  compileReleaseCatalogTiling,
  parseReleaseCatalogPartition,
  type ParsedReleaseCatalogPartition,
  type ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import type { Release } from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import type {
  ReleaseCatalogHead,
  ReleaseCatalogState,
} from "./core/catalogReads";
import { parseReleaseCatalogRow } from "./db/releaseCatalog";
import {
  createReleaseCatalogMemo,
  RELEASE_CATALOG_MEMO_SLOTS,
  RELEASE_CATALOG_MEMO_TTL_MS,
} from "./releaseCatalogMemo";

const release = (id: string, targetAppVersion: string): Release =>
  ({
    bundleId: `bundle-${id}`,
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    id: `0190a000-0000-7000-8000-${id.padStart(12, "0")}`,
    kind: "BUNDLE",
    message: null,
    platform: "ios",
    rolloutCohortCount: 1000,
    shouldForceUpdate: false,
    strategy: "APP_VERSION",
    targetAppVersion,
    targetCohorts: [],
  }) as unknown as Release;

/** Rows for exact versions 1.0.0, 2.0.0 and 3.0.0, and the gaps between them. */
const tiling = async (): Promise<ParsedReleaseCatalogPartition[]> =>
  (await compileReleaseCatalogTiling({
    releases: [
      release("1", "1.0.0"),
      release("2", "2.0.0"),
      release("3", "3.0.0"),
    ],
  }))!.map(parseReleaseCatalogPartition);

const rowOf = (scopeKey: string, generation: number) => ({
  byte_size: 0,
  catalog_hash: `sha256:${scopeKey}-${generation}`,
  catalog_id: `catalog-${scopeKey}`,
  channel_id: "channel",
  channel_key: "cHJvZHVjdGlvbg",
  fingerprint_hash: null,
  generation,
  is_tombstone: false,
  platform: "ios" as const,
  scope_key: scopeKey,
  strategy: "APP_VERSION" as const,
  updated_at_ms: 0,
});

const head = (
  scopeKey: string,
  generation: number,
  epoch = "e1",
): ReleaseCatalogHead => {
  const row = rowOf(scopeKey, generation);
  return {
    epoch,
    identity: JSON.stringify([
      row.catalog_id,
      generation,
      row.catalog_hash,
      epoch,
    ]),
    row,
  };
};

const compact = (scopeKey: string, generation = 1): ReleaseCatalogState => ({
  kind: "compact",
  parsed: parseReleaseCatalogRow({
    ...rowOf(scopeKey, generation),
    payload: JSON.stringify({
      fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
      releaseDescriptors: [],
      schemaVersion: 1,
      segments: [],
      strategy: "APP_VERSION",
    }),
  } satisfies ReleaseCatalogRow),
});

/** A read that waits for the test to settle it. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = async () => {
  let clock = 1_000;
  const memo = createReleaseCatalogMemo({ now: () => clock });
  const rows = await tiling();
  const covering = (version: string) =>
    rows.find((row) => row.covers(version))!;
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    covering,
    memo,
    partitioned: (
      scopeKey: string,
      version: string,
      generation = 1,
      epoch = "e1",
    ): ReleaseCatalogState => ({
      head: head(scopeKey, generation, epoch),
      kind: "partitioned",
      partition: covering(version),
    }),
  };
};

describe("release catalog memo", () => {
  it("serves every version inside a cached row, and reads a row once per new partition", async () => {
    const { memo, partitioned } = await setup();
    const calls: (ReleaseCatalogHead | undefined)[] = [];
    const read = (version: string) => async (cached?: ReleaseCatalogHead) => {
      calls.push(cached);
      return partitioned("s", version);
    };
    await memo.load("s", "1.0.0", read("1.0.0"));
    await memo.load("s", "1.0.0", read("1.0.0"));
    await memo.load("s", "2.0.0", read("2.0.0"));
    await memo.load("s", "2.0.0", read("2.0.0"));
    // 1.5.0 lies in the gap row between them: one more row read.
    const gap = await memo.load("s", "1.5.0", read("1.5.0"));
    expect(gap.kind === "partitioned" && gap.partition?.covers("1.5.0")).toBe(
      true,
    );
    expect(calls.map((cached) => cached?.identity ?? null)).toEqual([
      null,
      head("s", 1).identity,
      head("s", 1).identity,
    ]);
    expect(memo.stats()).toEqual({ entries: 1, used: 4 });
  });

  it("coalesces 20 checks of a missing scope into one read, and caches only a read that found no row", async () => {
    const { memo } = await setup();
    let reads = 0;
    const pending = deferred<ReleaseCatalogState>();
    const loads = Array.from({ length: 20 }, () =>
      memo.load("missing", "1.0.0", () => {
        reads += 1;
        return pending.promise;
      }),
    );
    pending.resolve({ kind: "none" });
    expect(await Promise.all(loads)).toEqual(
      Array.from({ length: 20 }, () => ({ kind: "none" })),
    );
    await memo.load("missing", "1.0.0", async () => {
      reads += 1;
      return { kind: "none" };
    });
    expect(reads).toBe(1);
    // A failed read caches nothing: the next check reads again.
    await expect(
      memo.load("failing", "1.0.0", async () => {
        throw new Error("503");
      }),
    ).rejects.toThrow("503");
    expect(
      await memo.load("failing", "1.0.0", async () => compact("failing")),
    ).toMatchObject({ kind: "compact" });
  });

  it("expires entries absolutely, five seconds after the load, whatever the hits", async () => {
    const { advance, memo } = await setup();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return compact("s");
    };
    await memo.load("s", "1.0.0", read);
    advance(RELEASE_CATALOG_MEMO_TTL_MS - 1);
    await memo.load("s", "1.0.0", read);
    advance(1);
    await memo.load("s", "1.0.0", read);
    expect(reads).toBe(2);
  });

  it("never attaches a row whose head expired while the row was in flight", async () => {
    const { advance, memo, partitioned } = await setup();
    await memo.load("s", "1.0.0", async () => partitioned("s", "1.0.0"));
    const row = deferred<ReleaseCatalogState>();
    const late = memo.load("s", "2.0.0", () => row.promise);
    await flush();
    advance(RELEASE_CATALOG_MEMO_TTL_MS);
    row.resolve(partitioned("s", "2.0.0"));
    // The request that started it gets its answer.
    expect(await late).toMatchObject({ kind: "partitioned" });
    expect(memo.stats()).toEqual({ entries: 0, used: 0 });
    // A new head load starts fresh, with no row from the expired one.
    let cachedSeen: ReleaseCatalogHead | undefined | null = null;
    await memo.load("s", "2.0.0", async (cached) => {
      cachedSeen = cached;
      return partitioned("s", "2.0.0", 2);
    });
    expect(cachedSeen).toBeUndefined();
    expect(memo.stats()).toEqual({ entries: 1, used: 2 });
  });

  it("never attaches a row to a head that replaced the one it was read under, while row loads coalesce", async () => {
    const { memo, partitioned } = await setup();
    await memo.load("s", "1.0.0", async () => partitioned("s", "1.0.0"));
    const oldRow = deferred<ReleaseCatalogState>();
    let rowReads = 0;
    const coalesced = Array.from({ length: 5 }, () =>
      memo.load("s", "2.0.0", () => {
        rowReads += 1;
        return oldRow.promise;
      }),
    );
    // Another version's row read finds the head moved on to generation 2.
    await memo.load("s", "3.0.0", async () =>
      partitioned("s", "3.0.0", 2, "e2"),
    );
    expect(memo.stats()).toEqual({ entries: 1, used: 2 });
    // The coalesced row of generation 1 arrives: it answers its requests only.
    oldRow.resolve(partitioned("s", "2.0.0"));
    for (const state of await Promise.all(coalesced)) {
      expect(state).toMatchObject({ head: { epoch: "e1" } });
    }
    expect(rowReads).toBe(1);
    expect(memo.stats()).toEqual({ entries: 1, used: 2 });
    // Generation 2's entry reads 2.0.0 under its own head.
    let cachedSeen: ReleaseCatalogHead | undefined;
    await memo.load("s", "2.0.0", async (cached) => {
      cachedSeen = cached;
      return partitioned("s", "2.0.0", 2, "e2");
    });
    expect(cachedSeen?.epoch).toBe("e2");
  });

  it("replaces a cached head with the compact row a row read found (head to compact)", async () => {
    const { memo, partitioned } = await setup();
    await memo.load("s", "1.0.0", async () => partitioned("s", "1.0.0"));
    expect(
      await memo.load("s", "2.0.0", async () => compact("s", 2)),
    ).toMatchObject({ kind: "compact" });
    let reads = 0;
    await memo.load("s", "3.0.0", async () => {
      reads += 1;
      return compact("s", 3);
    });
    expect(reads).toBe(0);
    expect(memo.stats()).toEqual({ entries: 1, used: 1 });
  });

  it("evicts at exactly 128 slots, counting rows, least recently used first, rows with their head", async () => {
    const { memo, partitioned } = await setup();
    // One head with 3 rows (4 slots), then 124 compact scopes: full.
    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
      await memo.load("big", version, async () => partitioned("big", version));
    }
    for (let at = 0; at < RELEASE_CATALOG_MEMO_SLOTS - 4; at += 1) {
      await memo.load(`c${at}`, "1.0.0", async () => compact(`c${at}`));
    }
    expect(memo.stats()).toEqual({
      entries: RELEASE_CATALOG_MEMO_SLOTS - 3,
      used: RELEASE_CATALOG_MEMO_SLOTS,
    });
    // One more compact scope evicts the least recently used: "big", 4 slots.
    await memo.load("extra", "1.0.0", async () => compact("extra"));
    expect(memo.stats()).toEqual({
      entries: RELEASE_CATALOG_MEMO_SLOTS - 3,
      used: RELEASE_CATALOG_MEMO_SLOTS - 3,
    });
    let reads = 0;
    await memo.load("big", "1.0.0", async () => {
      reads += 1;
      return partitioned("big", "1.0.0");
    });
    expect(reads).toBe(1);
  });

  it("never lets missing-scope churn evict a cached catalog; misses replace misses", async () => {
    const { memo } = await setup();
    for (let at = 0; at < RELEASE_CATALOG_MEMO_SLOTS - 1; at += 1) {
      await memo.load(`c${at}`, "1.0.0", async () => compact(`c${at}`));
    }
    let missReads = 0;
    for (let at = 0; at < 1_000; at += 1) {
      await memo.load(`missing-${at}`, "1.0.0", async () => {
        missReads += 1;
        return { kind: "none" };
      });
    }
    expect(missReads).toBe(1_000);
    expect(memo.stats()).toEqual({
      entries: RELEASE_CATALOG_MEMO_SLOTS,
      used: RELEASE_CATALOG_MEMO_SLOTS,
    });
    // Every catalog is still cached: no read.
    for (let at = 0; at < RELEASE_CATALOG_MEMO_SLOTS - 1; at += 1) {
      await memo.load(`c${at}`, "1.0.0", async () => {
        throw new Error(`c${at} was evicted`);
      });
    }
    // The last miss holds the one free slot: the newest replaced the others.
    await memo.load("missing-999", "1.0.0", async () => {
      throw new Error("the newest miss was evicted");
    });
    // With every slot positive, a miss isn't cached at all.
    await memo.load(`c${RELEASE_CATALOG_MEMO_SLOTS}`, "1.0.0", async () =>
      compact("last"),
    );
    let reads = 0;
    for (let at = 0; at < 2; at += 1) {
      await memo.load("missing-full", "1.0.0", async () => {
        reads += 1;
        return { kind: "none" };
      });
    }
    expect(reads).toBe(2);
  });
});
