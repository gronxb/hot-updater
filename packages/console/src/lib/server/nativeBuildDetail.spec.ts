// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import {
  type Bundle,
  createMemoryAdapter,
  type HotUpdaterCoreApi,
  type NativeBuildRegistration,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { nativeBuildCatalogScopeKey } from "../native-builds";
import {
  getNativeBuildDetail,
  listNativeBuildFolds,
  listNativeBuildPatches,
  readNativeBuildFold,
} from "./nativeBuilds";

const id = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** Native build IDs, apart from the bundle IDs. */
const buildId = (n: number) =>
  `01910000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const memoryCore = (): HotUpdaterCoreApi =>
  createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: mockStorage({}),
    clientAccess: "public",
  }).core;

type Scope = Pick<
  NativeBuildRegistration,
  "channel" | "platform" | "fingerprintHash" | "appVersion"
>;

const fingerprintScope = (
  fingerprintHash: string,
  channel = "production",
): Scope => ({
  platform: "android",
  channel,
  fingerprintHash,
  appVersion: null,
});

const register = (
  core: HotUpdaterCoreApi,
  n: number,
  minBundleId: string,
  scope: Scope = fingerprintScope("fp-a"),
) =>
  core.registerNativeBuild({
    ...scope,
    id: buildId(n),
    minBundleId,
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind: "apk",
      storageUri: `s3://bucket/native-builds/android/${buildId(n)}/app.apk`,
      byteSize: 1_000,
    },
    embeddedBundle: {
      manifestStorageUri: `s3://bucket/${minBundleId}/manifest.json`,
      manifestFileHash: `manifest-${minBundleId}`,
      assetBaseStorageUri: "s3://bucket/assets",
    },
  } as NativeBuildRegistration);

const bundle = (n: number, patchBases: readonly string[] = []): Bundle => ({
  id: id(n),
  platform: "android",
  gitCommitHash: null,
  manifestStorageUri: `s3://bucket/${id(n)}/manifest.json`,
  manifestFileHash: `manifest-${id(n)}`,
  assetBaseStorageUri: "s3://bucket/assets",
  patches: patchBases.map((base) => ({
    baseBundleId: base,
    baseFileHash: `manifest-${base}`,
    byteSize: 100 + n,
    patchFileHash: `patch-${n}-${base}`,
    patchStorageUri: `s3://bucket/patches/${n}/${base}`,
  })),
});

const deploy = (
  core: HotUpdaterCoreApi,
  deployed: Bundle,
  release: {
    readonly channel?: string;
    readonly fingerprintHash?: string | null;
    readonly targetAppVersion?: string | null;
    readonly enabled?: boolean;
  } = {},
) =>
  core.deploy([
    {
      bundle: deployed,
      release: {
        channel: release.channel ?? "production",
        enabled: release.enabled ?? true,
        fingerprintHash:
          release.fingerprintHash === undefined
            ? "fp-a"
            : release.fingerprintHash,
        message: `Bundle ${deployed.id}`,
        shouldForceUpdate: false,
        targetAppVersion: release.targetAppVersion ?? null,
      },
    },
  ]);

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

describe("getNativeBuildDetail", () => {
  it("serves an install the scope's releases down to its built-in bundle, and says how each downloads", async () => {
    const core = memoryCore();
    const minBundleId = id(10);
    await deploy(core, bundle(5));
    await register(core, 1, minBundleId);
    await deploy(core, bundle(20, [minBundleId]));
    await deploy(core, bundle(21));
    await deploy(core, bundle(22), { fingerprintHash: "fp-b" });
    await deploy(core, bundle(23, [id(5)]));
    await deploy(core, bundle(24, [minBundleId]), { enabled: false });

    const detail = await getNativeBuildDetail(core, buildId(1));

    // The test's own releases on fp-a, enabled, at or above the floor,
    // newest first: never the older bundle, another fingerprint, or the
    // disabled one.
    expect(detail?.servedNow.map(({ bundleId }) => bundleId)).toEqual([
      id(23),
      id(21),
      id(20),
    ]);
    // The patches from the built-in bundle are the ones the test wrote
    // with that base, the disabled release's too; none from another base.
    expect(detail?.patches).toEqual({
      data: [
        { bundleId: id(24), byteSize: 124 },
        { bundleId: id(20), byteSize: 120 },
      ],
    });
    expect(detail?.builtInBundle).toEqual({ childCount: 2 });
    expect(detail?.channel).toBe("production");
    expect(detail?.newestInScope?.id).toBe(buildId(1));
    expect(detail?.catalogScopeKey).toBe(
      createReleaseCatalogScopeKey({
        strategy: "FINGERPRINT",
        platform: "android",
        channelKey: encodeChannelKey("production"),
        fingerprintHash: "fp-a",
      }),
    );
  });

  it("reports a build superseded by a newer one of its scope", async () => {
    const core = memoryCore();
    await register(core, 1, id(10));
    await register(core, 2, id(11));
    await register(core, 3, id(12), fingerprintScope("fp-a", "pr-130"));

    expect(
      (await getNativeBuildDetail(core, buildId(1)))?.newestInScope?.id,
    ).toBe(buildId(2));
    expect(
      (await getNativeBuildDetail(core, buildId(2)))?.newestInScope?.id,
    ).toBe(buildId(2));
  });

  it("projects an app-version build's catalog at its own app version", async () => {
    const core = memoryCore();
    const scope: Scope = {
      platform: "android",
      channel: "beta",
      fingerprintHash: null,
      appVersion: "1.4.2",
    };
    const build = await register(core, 1, id(10), scope);
    await deploy(core, bundle(20), {
      channel: "beta",
      fingerprintHash: null,
      targetAppVersion: "1.4.x",
    });
    await deploy(core, bundle(21), {
      channel: "beta",
      fingerprintHash: null,
      targetAppVersion: "2.0.x",
    });

    const appVersionKey = createReleaseCatalogScopeKey({
      strategy: "APP_VERSION",
      platform: "android",
      channelKey: encodeChannelKey("beta"),
    });
    expect(nativeBuildCatalogScopeKey(build)).toBe(appVersionKey);
    expect(build.scope_key).toBe(`${appVersionKey}:1.4.2`);
    const detail = await getNativeBuildDetail(core, buildId(1));
    expect(detail?.servedNow.map(({ bundleId }) => bundleId)).toEqual([id(20)]);
  });

  it("serves a two-part version's install its own version's release, not a later patch version's", async () => {
    const core = memoryCore();
    const scope: Scope = {
      platform: "android",
      channel: "beta",
      fingerprintHash: null,
      appVersion: "1.7",
    };
    await register(core, 1, id(10), scope);
    await deploy(core, bundle(20), {
      channel: "beta",
      fingerprintHash: null,
      targetAppVersion: "1.7.0",
    });
    await deploy(core, bundle(21), {
      channel: "beta",
      fingerprintHash: null,
      targetAppVersion: "1.7.1",
    });

    const detail = await getNativeBuildDetail(core, buildId(1));
    expect(detail?.servedNow.map(({ bundleId }) => bundleId)).toEqual([id(20)]);
  });

  it("reads five times whatever the build, and nothing for an unknown ID", async () => {
    const memory = memoryCore();
    await register(memory, 1, id(10));
    for (const n of [20, 21, 22]) {
      await deploy(memory, bundle(n, [id(10)]));
    }
    const { core, calls } = counted(memory);

    await getNativeBuildDetail(core, buildId(1));
    expect(calls.sort()).toEqual(
      [
        "findNativeBuild",
        "findNativeBuild",
        "getBundle",
        "getNativeBuild",
        "getReleaseCatalogRow",
        "listPatchesFromBase",
      ].sort(),
    );

    calls.length = 0;
    await expect(getNativeBuildDetail(core, buildId(9))).resolves.toBeNull();
    expect(calls).toEqual(["getNativeBuild"]);
  });

  it("reads the scope's mark only for a build that doesn't hold it", async () => {
    const memory = memoryCore();
    await register(memory, 1, id(10));
    await register(memory, 2, id(11));
    await memory.markNativeBuild(buildId(1), { storeBuild: true });
    const { core, calls } = counted(memory);

    const marked = await getNativeBuildDetail(core, buildId(1));
    expect(marked?.storeBuildInScope?.id).toBe(buildId(1));
    expect(calls.filter((name) => name === "findNativeBuild")).toHaveLength(1);

    calls.length = 0;
    const other = await getNativeBuildDetail(core, buildId(2));
    expect(other?.storeBuildInScope?.id).toBe(buildId(1));
    expect(other?.newestInScope?.id).toBe(buildId(2));
    expect(calls.filter((name) => name === "findNativeBuild")).toHaveLength(2);
  });

  it("names no patch base for a sandbox build, and reads none", async () => {
    const memory = memoryCore();
    const sandbox = fingerprintScope("fp-a", "pr-128");
    await memory.registerNativeBuild({
      ...sandbox,
      isSandbox: true,
      sandboxUrlScheme: "acme-preview",
      sandboxAppId: "com.example.app.sandbox",
      id: buildId(1),
      minBundleId: id(10),
      gitCommitHash: null,
      buildKey: null,
      artifact: {
        kind: "apk",
        storageUri: `s3://bucket/native-builds/android/${buildId(1)}/app.apk`,
        byteSize: 1_000,
      },
      embeddedBundle: {
        manifestStorageUri: `s3://bucket/${id(10)}/manifest.json`,
        manifestFileHash: `manifest-${id(10)}`,
        assetBaseStorageUri: "s3://bucket/assets",
      },
    } as NativeBuildRegistration);
    const { core, calls } = counted(memory);

    const detail = await getNativeBuildDetail(core, buildId(1));
    expect(detail?.newestInScope).toBeNull();
    expect(detail?.storeBuildInScope).toBeNull();
    expect(calls).not.toContain("findNativeBuild");
  });
});

describe("the native build list and patch pages", () => {
  it("lists only a channel's builds, leading with its path's newest, in one read of the channel's index", async () => {
    const memory = memoryCore();
    await register(memory, 1, id(10));
    await register(memory, 2, id(11), fingerprintScope("fp-a", "pr-130"));
    await register(memory, 3, id(12), fingerprintScope("fp-b", "pr-130"));
    const { core, calls } = counted(memory);

    const page = await listNativeBuildFolds(core, {
      channelId: `channel:${encodeChannelKey("pr-130")}`,
    });

    // Both APKs of pr-130 are one path: 3 leads, 2 folds under it.
    expect(page.entries).toEqual([
      { kind: "row", row: expect.objectContaining({ id: buildId(3) }) },
      { kind: "fold", count: 1, more: false, from: buildId(3), to: buildId(2) },
    ]);
    // The newest page needs no read above it.
    expect(calls).toEqual(["listNativeBuilds"]);
  });

  it("folds a build whose newer build on its path is on an earlier page", async () => {
    const core = memoryCore();
    const channel = (n: number) => `c-${String(n).padStart(2, "0")}`;
    // Oldest first: an APK of c-01, c-02's only APK, then c-01's newer APK
    // and the newest APKs of c-03..c-21.
    await register(core, 1, id(100), fingerprintScope("fp-a", channel(1)));
    await register(core, 2, id(101), fingerprintScope("fp-a", channel(2)));
    await register(core, 3, id(102), fingerprintScope("fp-a", channel(1)));
    for (let n = 3; n <= 21; n += 1) {
      await register(
        core,
        n + 1,
        id(100 + n),
        fingerprintScope("fp-a", channel(n)),
      );
    }

    const first = await listNativeBuildFolds(core, {});
    // Twenty paths' newest builds, c-01's newer APK among them.
    expect(
      first.entries.flatMap((entry) =>
        entry.kind === "row" ? [entry.row.id] : ["fold"],
      ),
    ).toEqual(Array.from({ length: 20 }, (_, i) => buildId(22 - i)));
    const second = await listNativeBuildFolds(core, { before: first.next });

    // c-02 leads page 2; c-01's older APK folds, though its newer APK is on
    // page 1 and no build of its path is on this page.
    expect(second.entries).toEqual([
      { kind: "row", row: expect.objectContaining({ id: buildId(2) }) },
      { kind: "fold", count: 1, more: false, from: buildId(2), to: buildId(1) },
    ]);
    const fold = await readNativeBuildFold(core, {
      from: buildId(2),
      to: buildId(1),
    });
    expect(fold.rows.map(({ id: rowId }) => rowId)).toEqual([buildId(1)]);
    expect(fold.newer[buildId(1)]?.id).toBe(buildId(3));
  });

  it("pages the patches from a built-in bundle by target, newest first", async () => {
    const core = memoryCore();
    await register(core, 1, id(10));
    for (const n of [20, 21, 22]) await deploy(core, bundle(n, [id(10)]));

    const first = await listNativeBuildPatches(core, id(10), { limit: 2 });
    const second = await listNativeBuildPatches(core, id(10), {
      before: first.next,
      limit: 2,
    });
    const back = await listNativeBuildPatches(core, id(10), {
      after: second.previous,
      limit: 2,
    });

    expect(first.data.map(({ bundleId }) => bundleId)).toEqual([
      id(22),
      id(21),
    ]);
    expect(second.data.map(({ bundleId }) => bundleId)).toEqual([id(20)]);
    expect(back.data).toEqual(first.data);
  });
});
