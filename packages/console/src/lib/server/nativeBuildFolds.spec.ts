// @vitest-environment node

import { DatabaseSync } from "node:sqlite";

import { mockStorage } from "@hot-updater/mock";
import {
  createKvAdapter,
  createMemoryAdapter,
  createSqlAdapter,
  type DatabaseAdapter,
  generateEngineSql,
  type HotUpdaterCoreApi,
  type NativeBuildRegistration,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createMemoryKeyValueStore } from "@hot-updater/test-utils";
import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, describe, expect, it } from "vitest";

import type { FoldedEntry } from "./foldedPage";
import { listNativeBuildFolds, readNativeBuildFold } from "./nativeBuilds";

const sql = (dialect: "sqlite") => {
  const target = toolingTargetOf([]);
  return generateEngineSql(dialect, target.schema, target.settings);
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A key-value store under an RC-era writer, which knew no `export_method`:
 * every row and index copy it stores lacks the field, as an item DynamoDB,
 * Firestore or Cosmos DB holds from before it.
 */
const rcEraStore = () => {
  const store = createMemoryKeyValueStore();
  const without = (value: Readonly<Record<string, unknown>>) => {
    const { export_method: _dropped, ...rest } = value;
    return rest;
  };
  return {
    ...store,
    write: ((ops) =>
      store.write(
        ops.map((op) =>
          op.type === "put"
            ? { ...op, value: without(op.value) }
            : op.type === "add" && op.init !== undefined
              ? { ...op, init: without(op.init) }
              : op,
        ) as typeof ops,
      )) as typeof store.write,
  };
};

/**
 * Each provider family the lookup reads through: memory, a key-value store
 * (DynamoDB, Firestore, Cosmos DB), its RC-era rows, and SQL, by SQLite.
 */
const families: readonly [string, () => Promise<DatabaseAdapter>][] = [
  ["memory", async () => createMemoryAdapter()],
  [
    "key-value",
    async () => createKvAdapter({ store: createMemoryKeyValueStore() }),
  ],
  [
    "key-value rows written before export_method",
    async () => createKvAdapter({ store: rcEraStore() }),
  ],
  [
    "SQLite",
    async () => {
      const db = new DatabaseSync(":memory:");
      for (const statement of sql("sqlite")) db.exec(statement);
      cleanups.push(() => db.close());
      return createSqlAdapter({ executor: sqliteExecutor(db) });
    },
  ],
];

const buildId = (n: number) =>
  `01910000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const minBundleId = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const register = (
  core: HotUpdaterCoreApi,
  n: number,
  overrides: Partial<NativeBuildRegistration> = {},
) =>
  core.registerNativeBuild({
    id: buildId(n),
    platform: "ios",
    channel: "production",
    fingerprintHash: "fp-a",
    appVersion: null,
    minBundleId: minBundleId(n),
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind: "ipa",
      storageUri: `s3://bucket/native-builds/ios/${buildId(n)}/App.ipa`,
      byteSize: 1_000,
    },
    embeddedBundle: {
      manifestStorageUri: `s3://bucket/${minBundleId(n)}/manifest.json`,
      manifestFileHash: `manifest-${n}`,
      assetBaseStorageUri: "s3://bucket/assets",
    },
    ...overrides,
  } as NativeBuildRegistration);

/** Entries by build number: `n` for a row, `[count]` for a fold. */
const shape = (entries: readonly FoldedEntry<{ readonly id: string }>[]) =>
  entries.map((entry) =>
    entry.kind === "row"
      ? Number(entry.row.id.slice(-12))
      : `[${entry.count}${entry.more ? "+" : ""}]`,
  );

describe.each(families)("native build folds on %s", (_name, adapter) => {
  const setup = async () =>
    createHotUpdater({
      database: { name: "test", adapter: await adapter() },
      storage: mockStorage({}),
      clientAccess: "public",
    }).core;

  it("folds an older .ipa under the newest of its path, the legacy rows' plain IPA path included", async () => {
    const core = await setup();
    await register(core, 1);
    await register(core, 2);
    await register(core, 3, { exportMethod: "ad-hoc" });

    const page = await listNativeBuildFolds(core, {});

    // An RC-era store keeps no export method, so all three are on one path.
    const legacy = (await core.getNativeBuild(buildId(3)))?.export_method;
    expect(shape(page.entries)).toEqual(
      legacy === null ? [3, "[2]"] : [3, 2, "[1]"],
    );
  });

  it("finds a newer build on an earlier page by its channel's index, whatever wrote it", async () => {
    const core = await setup();
    const channel = (n: number) => `c-${String(n).padStart(2, "0")}`;
    // Oldest first: an IPA of c-01, c-02's only one, then c-01's newer IPA
    // and the newest IPA of c-03..c-21.
    await register(core, 1, { channel: channel(1) });
    await register(core, 2, { channel: channel(2) });
    await register(core, 3, { channel: channel(1) });
    for (let n = 3; n <= 21; n += 1) {
      await register(core, n + 1, { channel: channel(n) });
    }

    const first = await listNativeBuildFolds(core, {});
    expect(shape(first.entries)).toEqual(
      Array.from({ length: 20 }, (_, i) => 22 - i),
    );
    const second = await listNativeBuildFolds(core, { before: first.next });

    // c-01's older IPA folds, though its newer one is on page 1.
    expect(shape(second.entries)).toEqual([2, "[1]"]);
    const fold = await readNativeBuildFold(core, {
      from: buildId(2),
      to: buildId(1),
    });
    expect(fold.rows.map(({ id }) => id)).toEqual([buildId(1)]);
    expect(fold.newer[buildId(1)]?.id).toBe(buildId(3));
  });

  it("keeps an older build older after a write to it, and the newest the newest", async () => {
    const core = await setup();
    await register(core, 1);
    await register(core, 2);
    // A write rewrites build 1's row and its index items, not build 2's.
    await core.markNativeBuild(buildId(1), { storeBuild: true });
    await core.markNativeBuild(buildId(1), { storeBuild: false });

    const page = await listNativeBuildFolds(core, {});

    expect(shape(page.entries)).toEqual([2, "[1]"]);
  });
});

describe.each(families)(
  "native build pages beside a sandbox sibling pair on %s",
  (_name, adapter) => {
    /** Core, with every method it is called by, in order. */
    const setup = async () => {
      const core = createHotUpdater({
        database: { name: "test", adapter: await adapter() },
        storage: mockStorage({}),
        clientAccess: "public",
      }).core;
      const calls: string[] = [];
      const counted = new Proxy(core, {
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
      return { core, counted, calls };
    };
    const sandbox = (
      channel: string,
      appId: string,
    ): Partial<NativeBuildRegistration> => ({
      channel,
      isSandbox: true,
      sandboxAppId: appId,
      sandboxUrlScheme: "acme-preview",
      exportMethod: "ad-hoc",
    });

    /**
     * Oldest first: an older sandbox .ipa of pr-3, a sandbox Simulator .app
     * of `appId` on pr-2, the newer sandbox .ipa of pr-3, then 19 newer
     * channels' builds. Page 1 ends on the .ipa, page 2 starts on the .app,
     * and the older .ipa folds under the newer one on page 1.
     */
    const registry = async (appId: string) => {
      const { core, counted, calls } = await setup();
      await register(core, 1, sandbox("pr-3", "com.example.app"));
      await register(core, 2, {
        ...sandbox("pr-2", appId),
        exportMethod: null,
        artifact: {
          kind: "app",
          storageUri: `s3://bucket/native-builds/ios/${buildId(2)}/App.app.zip`,
          byteSize: 1_000,
        },
      });
      await register(core, 3, sandbox("pr-3", "com.example.app"));
      for (let n = 4; n <= 22; n += 1) {
        await register(core, n, { channel: `c-${n}` });
      }
      return { core, counted, calls };
    };
    const pages = async (core: HotUpdaterCoreApi) => {
      const first = await listNativeBuildFolds(core, {});
      const second = await listNativeBuildFolds(core, { before: first.next });
      const fold = await readNativeBuildFold(core, {
        from: buildId(2),
        to: buildId(1),
      });
      return { first, second, fold };
    };

    it("lists the same pages, page boundary, and fold through its last row as builds of no pair", async () => {
      const paired = await registry("com.example.app");
      const unpaired = await registry("com.example.other");
      // The pair is one: each is the other's install target, unless an
      // RC-era store dropped the .ipa's export method, which a target needs.
      const ipa = (await paired.core.getNativeBuild(buildId(3)))!;
      const app = (await paired.core.getNativeBuild(buildId(2)))!;
      const pair = ipa.export_method === null ? [null, null] : [2, 3];
      expect(
        [
          await paired.core.findNativeBuildSibling(ipa),
          await paired.core.findNativeBuildSibling(app),
        ].map((sibling) =>
          sibling === null ? null : Number(sibling.id.slice(-12)),
        ),
      ).toEqual(pair);
      expect(
        await unpaired.core.findNativeBuildSibling(
          (await unpaired.core.getNativeBuild(buildId(3)))!,
        ),
      ).toBeNull();

      const withPair = await pages(paired.counted);
      const withoutPair = await pages(unpaired.counted);

      // Page 1 ends on the .ipa, and page 2 starts on its .app.
      expect(shape(withPair.first.entries)).toEqual(
        Array.from({ length: 20 }, (_, i) => 22 - i),
      );
      expect(shape(withPair.second.entries)).toEqual([2, "[1]"]);
      expect(withPair.fold.rows.map(({ id }) => id)).toEqual([buildId(1)]);
      expect(withPair.fold.newer[buildId(1)]?.id).toBe(buildId(3));
      // Each build once, in the registry's order, as with no pair.
      const ids = (page: typeof withPair) =>
        [...page.first.entries, ...page.second.entries].map((entry) =>
          entry.kind === "row" ? entry.row.id : `fold:${entry.to}`,
        );
      expect(ids(withPair)).toEqual(ids(withoutPair));
      expect(withPair.first.next).toBe(withoutPair.first.next);
      expect(withPair.second.previous).toEqual(withoutPair.second.previous);
      expect(withPair.second.next).toBe(withoutPair.second.next);
      const foldIds = ({ fold }: typeof withPair) => ({
        rows: fold.rows.map(({ id }) => id),
        newer: Object.fromEntries(
          Object.entries(fold.newer).map(([id, row]) => [id, row.id]),
        ),
        next: fold.next,
      });
      expect(foldIds(withPair)).toEqual(foldIds(withoutPair));
      // The list reads the same, and never a sibling.
      expect(paired.calls).toEqual(unpaired.calls);
      expect(paired.calls).not.toContain("findNativeBuildSibling");
    });
  },
);

describe("native build folds past the read budget", () => {
  const core = () =>
    createHotUpdater({
      database: { name: "test", adapter: createMemoryAdapter() },
      storage: mockStorage({}),
      clientAccess: "public",
    }).core;
  const apk = (n: number): Partial<NativeBuildRegistration> => ({
    platform: "android",
    artifact: {
      kind: "apk",
      storageUri: `s3://bucket/native-builds/android/${n}/app.apk`,
      byteSize: 1,
    },
  });

  it("folds a build whose newer build is the last row of the page before", async () => {
    const memory = core();
    // Oldest first: an APK of production, c-02's only build, then the newer
    // production APK and 19 newer channels' builds.
    await register(memory, 1, apk(1));
    await register(memory, 2, { channel: "c-02" });
    await register(memory, 3, apk(3));
    for (let n = 4; n <= 22; n += 1) {
      await register(memory, n, { channel: `c-${n}` });
    }

    const first = await listNativeBuildFolds(memory, {});
    // The newer APK is page 1's last row, the cursor of page 2.
    expect(shape(first.entries).at(-1)).toBe(3);
    const second = await listNativeBuildFolds(memory, { before: first.next });

    expect(shape(second.entries)).toEqual([2, "[1]"]);
  });

  it("shows a build as leading when its newer build is past the rows it may read above the page", async () => {
    const memory = core();
    // Oldest first: an APK of production, a build of c-99, 110 production
    // IPAs, the newer APK, and 18 newer channels' builds. Page 1 ends over
    // c-99, and looking up from page 2, the IPAs fill the 100 rows a page
    // reads above itself before the newer APK.
    await register(memory, 1, apk(1));
    await register(memory, 2, { channel: "c-99" });
    for (let n = 3; n <= 112; n += 1) await register(memory, n);
    await register(memory, 113, apk(113));
    for (let n = 114; n <= 131; n += 1) {
      await register(memory, n, { channel: `c-${n}` });
    }

    const first = await listNativeBuildFolds(memory, {});
    const second = await listNativeBuildFolds(memory, { before: first.next });

    // A stated limit: unproven older is shown as leading.
    expect(shape(second.entries)).toEqual([2, 1]);
  });
});
