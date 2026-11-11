// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import {
  type Bundle,
  createMemoryAdapter,
  type HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import type { FoldedEntry } from "./foldedPage";
import { listReleaseFolds, readReleaseFold } from "./listReleases";
import type { ReleaseListRow } from "./releaseReachability";

const bundleId = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const memoryCore = (): HotUpdaterCoreApi =>
  createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: mockStorage({}),
    clientAccess: "public",
  }).core;

const bundle = (n: number): Bundle => ({
  id: bundleId(n),
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: `s3://bucket/${bundleId(n)}/manifest.json`,
  manifestFileHash: `manifest-${n}`,
  assetBaseStorageUri: "s3://bucket/assets",
});

/**
 * Deploys bundles 1..count to production's fingerprint `fp-a`, oldest
 * first, each to every device: only the newest enabled one is reachable.
 * `disabled` deploys those disabled. Answers the release IDs, oldest first.
 */
const deployAll = async (
  core: HotUpdaterCoreApi,
  count: number,
  disabled: ReadonlySet<number> = new Set(),
) => {
  for (let n = 1; n <= count; n += 1) {
    await core.deploy([
      {
        bundle: bundle(n),
        release: {
          channel: "production",
          enabled: !disabled.has(n),
          fingerprintHash: "fp-a",
          message: `Bundle ${n}`,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);
  }
  return (await core.listReleases({ filter: { kind: "all" }, limit: 100 }))
    .map(({ id }) => id)
    .sort();
};

/** Counts every call the core gets, by method. */
const counted = (core: HotUpdaterCoreApi) => {
  const calls: string[] = [];
  const proxy = new Proxy(core, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: unknown[]) => {
            calls.push(String(key));
            return value.apply(target, args);
          }
        : value;
    },
  });
  return { core: proxy, calls };
};

/** Entries as release IDs, and `[count]` for a fold. */
const shape = (
  entries: readonly FoldedEntry<ReleaseListRow>[],
  ids: readonly string[],
) =>
  entries.map((entry) =>
    entry.kind === "row"
      ? `r${ids.indexOf(entry.row.id) + 1}`
      : `[${entry.count}${entry.more ? "+" : ""}]`,
  );

const all = { kind: "all" } as const;

describe("listReleaseFolds", () => {
  it("leads with the reachable releases, each run of unreachable ones a fold where it sits", async () => {
    const core = memoryCore();
    // Only 5 is reachable: it reaches every device before 1..4.
    const ids = await deployAll(core, 5);

    const page = await listReleaseFolds(core, { filter: all });

    expect(shape(page.entries, ids)).toEqual(["r5", "[4]"]);
    expect(page.entries[1]).toEqual({
      kind: "fold",
      count: 4,
      more: false,
      from: ids[4],
      to: ids[0],
    });
    const fold = await readReleaseFold(core, {
      filter: all,
      from: ids[4],
      to: ids[0],
    });
    expect(fold.rows.map(({ id }) => id)).toEqual([
      ids[3],
      ids[2],
      ids[1],
      ids[0],
    ]);
    expect(fold.rows.every((row) => row.currentlyUnreachable)).toBe(true);
  });

  it("keeps the selected release where it is, splitting its fold around it", async () => {
    const core = memoryCore();
    const ids = await deployAll(core, 5);

    const page = await listReleaseFolds(core, {
      filter: all,
      releaseId: ids[2],
    });

    expect(shape(page.entries, ids)).toEqual(["r5", "[1]", "r3", "[2]"]);
    expect(page.entries[2]).toMatchObject({
      kind: "row",
      row: { id: ids[2], currentlyUnreachable: true },
    });
  });

  it("keeps a release selected in the fold that ends a full page on that page", async () => {
    const core = memoryCore();
    // Oldest first: a reachable release, a disabled one, then 20 reachable
    // releases, each its fingerprint's only one.
    // A millisecond apart, so release IDs follow the deploys.
    const deploy = async (n: number, enabled = true) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await core.deploy([
        {
          bundle: bundle(n),
          release: {
            channel: "production",
            enabled,
            fingerprintHash: `fp-${n}`,
            message: `Bundle ${n}`,
            shouldForceUpdate: false,
            targetAppVersion: null,
          },
        },
      ]);
    };
    await deploy(1);
    await deploy(2, false);
    for (let n = 3; n <= 22; n += 1) await deploy(n);
    /** Entries by bundle: `b2` for bundle 2's release, `[n]` for a fold. */
    const byBundle = (entries: readonly FoldedEntry<ReleaseListRow>[]) =>
      entries.map((entry) =>
        entry.kind === "row"
          ? `b${Number(entry.row.bundle_id!.slice(-12))}`
          : `[${entry.count}]`,
      );
    const disabled = (
      await core.listReleases({
        filter: { kind: "bundle", bundleId: bundleId(2) },
        limit: 1,
      })
    )[0]!.id;

    const page = await listReleaseFolds(core, { filter: all });
    // 20 reachable releases, then the run under the 20th: the disabled one.
    expect(byBundle(page.entries).filter((entry) => entry === "[1]")).toEqual([
      "[1]",
    ]);
    expect(byBundle(page.entries).at(-1)).toBe("[1]");
    expect(page.entries.filter(({ kind }) => kind === "row")).toHaveLength(20);

    // Selecting it from that fold keeps it on this page, as a row, where the
    // fold was; the next page starts where it did.
    const selected = await listReleaseFolds(core, {
      filter: all,
      releaseId: disabled,
    });
    expect(byBundle(selected.entries).at(-1)).toBe("b2");
    expect(selected.entries.filter(({ kind }) => kind === "row")).toHaveLength(
      21,
    );
    expect(selected.next).toBe(page.next);
  });

  it("folds none under a filter that asks for unreachable releases", async () => {
    const core = memoryCore();
    const ids = await deployAll(core, 4, new Set([2, 3]));
    const channelId = (await core.listChannels())[0]!.id;

    const disabled = await listReleaseFolds(core, {
      filter: {
        kind: "channelPlatform",
        channelId,
        platform: "ios",
        enabled: false,
      },
    });
    expect(shape(disabled.entries, ids)).toEqual(["r3", "r2"]);

    const one = await listReleaseFolds(core, {
      filter: { kind: "bundle", bundleId: bundleId(1) },
    });
    expect(shape(one.entries, ids)).toEqual(["r1"]);
  });

  it("shows a page of unreachable releases alone as one fold with its count", async () => {
    const core = memoryCore();
    const ids = await deployAll(core, 3, new Set([1, 2, 3]));

    const page = await listReleaseFolds(core, { filter: all });

    expect(shape(page.entries, ids)).toEqual(["[3]"]);
  });

  it("reads the filter's index a chunk at a time and each scope's catalog once", async () => {
    const memory = memoryCore();
    await deployAll(memory, 30);
    const { core, calls } = counted(memory);

    await listReleaseFolds(core, { filter: all });

    expect(calls.filter((call) => call === "listReleases")).toHaveLength(1);
    expect(
      calls.filter((call) => call === "getReleaseCatalogRow"),
    ).toHaveLength(1);
  });
});
