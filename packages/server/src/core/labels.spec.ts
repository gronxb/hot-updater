import {
  createEngine,
  createKvAdapter,
  createMemoryAdapter,
  type Bundle,
  type DatabaseAdapter,
  type Deployment,
  type KvKey,
  type StoredRow,
} from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import {
  createBundleFixture,
  createCapacityCappedStore,
  createMemoryKeyValueStore,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "./inProcess.testFixtures";
import { changeReleases } from "./releases";

const channelId = (name: string) => `channel:${encodeChannelKey(name)}`;

const setup = (adapter: DatabaseAdapter = createMemoryAdapter()) => {
  let clock = 1_000;
  const now = () => (clock += 1);
  const core = createInProcessCoreApi(adapter, { now });
  // A second engine on the same store, for rows as an earlier release wrote them.
  const raw = createEngine({ name: "raw", adapter }).core;
  return { adapter, core, raw, now };
};

let suffix = 0;
const nextBundle = (): Bundle =>
  createBundleFixture(String(100 + (suffix += 1)));

const deployment = (
  bundle: Bundle,
  policy: Partial<Deployment["release"]> = {},
): Deployment => ({
  bundle,
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: null,
    shouldForceUpdate: false,
    targetAppVersion: "1.0.0",
    ...policy,
  },
});

type Core = ReturnType<typeof setup>["core"];

const deploy = async (
  core: Core,
  policy: Partial<Deployment["release"]> = {},
) => {
  const [result] = await core.deploy([deployment(nextBundle(), policy)]);
  return result!.release!;
};

const labelsOf = async (core: Core, channel = "production") =>
  (
    await core.listReleases({
      filter: {
        kind: "channelPlatform",
        channelId: channelId(channel),
        platform: "ios",
      },
      limit: 100,
    })
  ).map(({ label }) => label);

/** Takes the labels off every release and drops the counters, as a 1.1 database has. */
const asBeforeLabels = async ({ raw }: ReturnType<typeof setup>) => {
  const { rows } = await raw.findMany("releases", {
    index: "all",
    where: {},
    limit: 100,
  });
  const { rows: counters } = await raw.findMany("label_sequences", {
    index: "all",
    where: {},
    limit: 100,
  });
  await raw.transaction(async (tx) => {
    for (const { id } of rows) {
      const row = await tx.findOne("releases", { id });
      if (row !== null) tx.update("releases", row, { label: null });
    }
    for (const { id } of counters) {
      const counter = await tx.findOne("label_sequences", { id });
      if (counter !== null) await tx.delete("label_sequences", counter);
    }
  });
};

/** Takes the label off one release and gives it back to its counter, as a 1.1 server writes one. */
const asWrittenByEarlierServer = async (
  { raw }: ReturnType<typeof setup>,
  releaseId: string,
) => {
  await raw.transaction(async (tx) => {
    const row = await tx.findOne("releases", { id: releaseId });
    const counter = await tx.findOne("label_sequences", {
      id: `releases/${row!.platform}/${row!.channel_id}`,
    });
    tx.update("releases", row!, { label: null });
    tx.update("label_sequences", counter!, {
      last_label: counter!.last_label - 1,
    });
  });
};

describe("release labels", () => {
  it("labels deploys of a channel and platform v1, v2, and each platform on its own", async () => {
    const { core } = setup();

    const first = await deploy(core);
    const second = await deploy(core);
    const [android] = await core.deploy([
      deployment({ ...nextBundle(), platform: "android" }),
    ]);

    expect([first.label, second.label]).toEqual([1, 2]);
    expect(android!.release!.label).toBe(1);
    await expect(core.getRelease(second.id)).resolves.toMatchObject({
      label: 2,
    });
  });

  it("gives a promote the target's next label and keeps the source's", async () => {
    const { core } = setup();
    await deploy(core);
    const source = await deploy(core);

    const copied = await core.promoteRelease({
      releaseId: source.id,
      targetChannel: "beta",
    });
    const moved = await core.promoteRelease({
      releaseId: source.id,
      targetChannel: "staging",
      action: "move",
    });

    expect(copied.target.release!.label).toBe(1);
    expect(moved.target.release!.label).toBe(1);
    expect(moved.source!.release).toMatchObject({ enabled: false, label: 2 });
    await expect(labelsOf(core)).resolves.toEqual([1, 2]);
  });

  it("never reuses a deleted release's label, and keeps labels through disable and enable", async () => {
    const { core } = setup();
    await deploy(core);
    const second = await deploy(core);

    const disabled = await core.updateReleasePolicy({
      releaseId: second.id,
      patch: { enabled: false },
    });
    expect(disabled.release!.label).toBe(2);
    await core.deleteRelease({ releaseId: second.id });
    const third = await deploy(core);
    const enabled = await core.updateReleasePolicy({
      releaseId: third.id,
      patch: { enabled: false },
    });
    const again = await core.updateReleasePolicy({
      releaseId: third.id,
      patch: { enabled: true },
    });

    expect(third.label).toBe(3);
    expect(enabled.release!.label).toBe(3);
    expect(again.release!.label).toBe(3);
    await expect(labelsOf(core)).resolves.toEqual([1, 3]);
  });

  it("never changes a label through an update, even one that names it", async () => {
    const { core, raw } = setup();
    const release = await deploy(core);

    const [updated] = await changeReleases(raw, [
      {
        scope: {
          channelId: release.channel_id,
          channelName: "production",
          fingerprintHash: null,
          platform: "ios",
          scopeKey: release.scope_key,
          strategy: "APP_VERSION",
        },
        change: {
          operation: "update",
          id: release.id,
          update: { message: "renamed", label: 9 } as never,
        },
        updatedAtMs: 5_000,
      },
    ]);

    expect(updated!.release).toMatchObject({ message: "renamed", label: 1 });
    await expect(core.getRelease(release.id)).resolves.toMatchObject({
      label: 1,
    });
  });

  it("takes consecutive labels for two fingerprints of one channel and platform in one batch", async () => {
    const { core, adapter } = setup();
    const counterWrites: number[] = [];
    const watched = createInProcessCoreApi({
      ...adapter,
      write: async (ops) => {
        counterWrites.push(
          ops.filter(({ table }) => table.name === "label_sequences").length,
        );
        return adapter.write(ops);
      },
    });
    await deploy(core, { fingerprintHash: "a", targetAppVersion: null });

    const results = await watched.deploy([
      deployment(nextBundle(), {
        fingerprintHash: "a",
        targetAppVersion: null,
      }),
      deployment(nextBundle(), {
        fingerprintHash: "b",
        targetAppVersion: null,
      }),
    ]);

    expect(results.map(({ release }) => release!.label)).toEqual([2, 3]);
    expect(counterWrites.at(-1)).toBe(1);
  });

  it("labels releases from before labels in ID order across fingerprints, before a deploy takes its own", async () => {
    const context = setup();
    const { core } = context;
    const a1 = await deploy(core, {
      fingerprintHash: "a",
      targetAppVersion: null,
    });
    const b1 = await deploy(core, {
      fingerprintHash: "b",
      targetAppVersion: null,
    });
    const a2 = await deploy(core, {
      fingerprintHash: "a",
      targetAppVersion: null,
    });
    await asBeforeLabels(context);
    await expect(labelsOf(core)).resolves.toEqual([null, null, null]);

    const next = await deploy(core, {
      fingerprintHash: "b",
      targetAppVersion: null,
    });

    expect(next.label).toBe(4);
    const byId = new Map(
      (
        await core.listReleases({
          filter: {
            kind: "channelPlatform",
            channelId: channelId("production"),
            platform: "ios",
          },
          limit: 10,
        })
      ).map((release) => [release.id, release.label]),
    );
    // ID order is creation order, to the millisecond; two scopes' IDs of one
    // millisecond sort by their random bits.
    const inIdOrder = [a1, b1, a2].map(({ id }) => id).toSorted();
    expect(inIdOrder.map((id) => byId.get(id))).toEqual([1, 2, 3]);
  });

  it("labels a release an earlier server wrote after the fill at the next deploy in its scope, and its catalog serves both", async () => {
    const context = setup();
    const { core } = context;
    await deploy(core);
    const stale = await deploy(core);
    await asWrittenByEarlierServer(context, stale.id);

    const next = await deploy(core);

    await expect(core.getRelease(stale.id)).resolves.toMatchObject({
      label: 2,
    });
    expect(next.label).toBe(3);
    const catalog = await core.getReleaseCatalogRow(next.scope_key);
    const { releaseDescriptors } = JSON.parse(catalog!.payload) as {
      releaseDescriptors: { releaseId: string; label?: number }[];
    };
    expect(
      Object.fromEntries(
        releaseDescriptors.map(({ releaseId, label }) => [releaseId, label]),
      ),
    ).toMatchObject({ [stale.id]: 2, [next.id]: 3 });
  });

  it("labels a long catch-up through the paged fill when the write is too large for the store", async () => {
    const memory = createMemoryAdapter();
    let limit = Infinity;
    const adapter: DatabaseAdapter = {
      ...memory,
      fits: (ops) => ops.length <= limit && memory.fits(ops),
    };
    const context = setup(adapter);
    const { core } = context;
    const released = [];
    for (let n = 0; n < 6; n += 1) released.push(await deploy(core));
    await asBeforeLabels(context);
    await core.fillReleaseLabels();
    const stale = [];
    for (let n = 0; n < 6; n += 1) stale.push(await deploy(core));
    for (const { id } of stale.toReversed()) {
      await asWrittenByEarlierServer(context, id);
    }
    limit = 8;

    const next = await deploy(core);

    expect(next.label).toBe(13);
    await expect(labelsOf(core)).resolves.toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("labels releases from before labels through a store with a write-capacity cap, in transactions the cap admits", async () => {
    // Room for the setup's one-transaction label wipe; the cap alone refuses
    // the fill's larger transactions.
    const inner = createMemoryKeyValueStore({
      limits: { items: 10_000, bytes: 4_000_000 },
    });
    // `hot-updater init` caps an AWS table at 100 write units a second.
    const capped = createCapacityCappedStore(inner, { unitsPerSecond: 100 });
    let store: typeof inner | typeof capped = inner;
    const context = setup(
      createKvAdapter({
        store: { ...inner, write: (ops) => store.write(ops) },
      }),
    );
    const { core } = context;
    for (let n = 0; n < 30; n += 1) await deploy(core);
    await asBeforeLabels(context);
    store = capped;

    await expect(core.fillReleaseLabels({ catalogs: false })).resolves.toEqual(
      { releases: 30, catalogs: 0 },
    );

    expect(capped.throttles()).toBeGreaterThan(0);
    store = inner;
    await expect(labelsOf(core)).resolves.toEqual(
      Array.from({ length: 30 }, (_, n) => n + 1),
    );
  });

  it("starts a channel deleted and created again at v1, with no counter left behind", async () => {
    const context = setup();
    const { core, raw } = context;
    const release = await deploy(core, { channel: "pr-1" });
    await core.updateReleasePolicy({
      releaseId: release.id,
      patch: { enabled: false },
    });
    await core.deleteRelease({ releaseId: release.id });

    await expect(core.deleteChannel(channelId("pr-1"))).resolves.toEqual({
      deleted: true,
    });
    await expect(
      raw.findOne("label_sequences", {
        id: `releases/ios/${channelId("pr-1")}`,
      }),
    ).resolves.toBeNull();
    const again = await deploy(core, { channel: "pr-1" });

    expect(again.label).toBe(1);
  });

  it("never gives two concurrent deploys one label", async () => {
    const { core } = setup();
    await deploy(core);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        deploy(core, {
          fingerprintHash: `f${n}`,
          targetAppVersion: null,
        }),
      ),
    );

    expect(results.map(({ label }) => label).toSorted()).toEqual([
      2, 3, 4, 5, 6, 7,
    ]);
  });

  it("finds a release by its label, and nothing for a label no release holds", async () => {
    const { core } = setup();
    await deploy(core);
    const second = await deploy(core);

    await expect(
      core.getReleaseByLabel({
        channel: "production",
        platform: "ios",
        label: 2,
      }),
    ).resolves.toMatchObject({ id: second.id, label: 2 });
    await expect(
      core.getReleaseByLabel({
        channel: "production",
        platform: "ios",
        label: 3,
      }),
    ).resolves.toBeNull();
    await expect(
      core.getReleaseByLabel({
        channel: "production",
        platform: "android",
        label: 2,
      }),
    ).resolves.toBeNull();
  });

  it("fills releases and rebuilds the catalogs that lack labels, and counts both in a dry run", async () => {
    const context = setup();
    const { core } = context;
    const first = await deploy(core);
    await deploy(core, { channel: "beta" });
    await asBeforeLabels(context);
    // Catalogs compiled while the releases had no labels.
    for (const scopeKey of await core.listReleaseScopeKeys({ limit: 10 })) {
      await core.rebuildReleaseCatalog(scopeKey);
    }

    await expect(core.fillReleaseLabels({ dryRun: true })).resolves.toEqual({
      releases: 2,
      catalogs: 0,
    });
    await expect(labelsOf(core)).resolves.toEqual([null]);
    await expect(core.fillReleaseLabels()).resolves.toEqual({
      releases: 2,
      catalogs: 2,
    });

    await expect(core.getRelease(first.id)).resolves.toMatchObject({
      label: 1,
    });
    const catalog = await core.getReleaseCatalogRow(first.scope_key);
    expect(JSON.parse(catalog!.payload).releaseDescriptors).toMatchObject([
      { releaseId: first.id, label: 1 },
    ]);
    await expect(core.fillReleaseLabels({ dryRun: true })).resolves.toEqual({
      releases: 0,
      catalogs: 0,
    });
    await expect(
      core.preflightReleaseCatalogRebuild(first.scope_key),
    ).resolves.toMatchObject({ changed: false });
  });

  it("reports a catalog that lacks only labels apart from a stale one", async () => {
    const context = setup();
    const { core, raw } = context;
    const release = await deploy(core);
    await asBeforeLabels(context);
    await core.rebuildReleaseCatalog(release.scope_key);
    await core.fillReleaseLabels({ catalogs: false });

    await expect(
      core.preflightReleaseCatalogRebuild(release.scope_key),
    ).resolves.toMatchObject({ changed: true, labelsOnly: true });
    await raw.transaction(async (tx) => {
      const row = await tx.findOne("releases", { id: release.id });
      tx.update("releases", row!, { message: "edited outside" });
    });
    await expect(
      core.preflightReleaseCatalogRebuild(release.scope_key),
    ).resolves.toMatchObject({ changed: true, labelsOnly: false });
  });

  it("fills every pair a deploy batch needs, however many channels it spans", async () => {
    const context = setup();
    const { core } = context;
    const channels = ["a", "b", "c", "d", "e", "f"];
    for (const channel of channels) await deploy(core, { channel });
    await asBeforeLabels(context);

    const results = await core.deploy(
      channels.map((channel) => deployment(nextBundle(), { channel })),
    );

    expect(results.map((result) => result.release!.label)).toEqual(
      channels.map(() => 2),
    );
    for (const channel of channels) {
      await expect(labelsOf(core, channel)).resolves.toEqual([1, 2]);
    }
  });

  it("fills releases a key-value store holds without a label field, as an earlier server wrote them", async () => {
    // An earlier server's release items have no `label` field at all, and no
    // label index items.
    const store = createMemoryKeyValueStore();
    let earlier = true;
    const context = setup(
      createKvAdapter({
        store: {
          ...store,
          write: (ops) =>
            store.write(
              earlier
                ? ops
                    .filter(
                      (op) =>
                        !(
                          op.type === "put" &&
                          op.key.pk.startsWith("releases#byLabel#")
                        ),
                    )
                    .map((op) => {
                      if (
                        op.type !== "put" ||
                        !/^releases(#|$)/u.test(op.key.pk)
                      )
                        return op;
                      const { label: _, ...value } = op.value as StoredRow & {
                        label?: unknown;
                      };
                      return { ...op, value: value as StoredRow };
                    })
                : ops,
            ),
        },
      }),
    );
    const { core, raw } = context;
    const releases = [
      await deploy(core),
      await deploy(core),
      await deploy(core),
    ];
    const { rows: counters } = await raw.findMany("label_sequences", {
      index: "all",
      where: {},
      limit: 10,
    });
    await raw.transaction(async (tx) => {
      for (const { id } of counters) {
        const counter = await tx.findOne("label_sequences", { id });
        if (counter !== null) await tx.delete("label_sequences", counter);
      }
    });
    earlier = false;
    expect(
      await raw.findOne("releases", { id: releases[0]!.id }),
    ).not.toHaveProperty("label");

    await expect(core.fillReleaseLabels()).resolves.toMatchObject({
      releases: 3,
    });

    const labeled = [];
    for (const { id } of releases) {
      labeled.push((await core.getRelease(id))?.label);
    }
    expect(labeled).toEqual([1, 2, 3]);
    await expect(core.fillReleaseLabels({ dryRun: true })).resolves.toEqual({
      releases: 0,
      catalogs: 0,
    });
  });

  it("skips a label an index item a server of an earlier release left behind still holds", async () => {
    // A key-value store keeps each unique entry as an item of its own, which
    // a server that knows no label index leaves behind when it deletes the row.
    const store = createMemoryKeyValueStore();
    const kept = new Map<string, { key: KvKey; value: StoredRow }>();
    const context = setup(
      createKvAdapter({
        store: {
          ...store,
          write: async (ops) => {
            for (const op of ops) {
              if (
                op.type === "put" &&
                op.key.pk.startsWith("releases#byLabel#")
              ) {
                kept.set(JSON.stringify(op.key), {
                  key: op.key,
                  value: op.value,
                });
              }
            }
            return store.write(ops);
          },
        },
      }),
    );
    const { core } = context;
    const release = await deploy(core, { channel: "pr-2" });
    await core.updateReleasePolicy({
      releaseId: release.id,
      patch: { enabled: false },
    });
    await core.deleteRelease({ releaseId: release.id });
    await core.deleteChannel(channelId("pr-2"));
    // The label 1 entry, as the earlier server left it.
    await store.write(
      [...kept.values()].map(({ key, value }) => ({
        type: "put" as const,
        key,
        value,
      })),
    );

    const again = await deploy(core, { channel: "pr-2" });

    expect(again.label).toBe(2);
    await expect(
      core.getReleaseByLabel({ channel: "pr-2", platform: "ios", label: 1 }),
    ).resolves.toBeNull();
    await expect(
      core.getReleaseByLabel({ channel: "pr-2", platform: "ios", label: 2 }),
    ).resolves.toMatchObject({ id: again.id });
  });
});
