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
  listNativeBuildPatches,
  listNativeBuilds,
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
});

describe("the native build list and patch pages", () => {
  it("lists only a channel's builds, one read per page", async () => {
    const memory = memoryCore();
    await register(memory, 1, id(10));
    await register(memory, 2, id(11), fingerprintScope("fp-a", "pr-130"));
    await register(memory, 3, id(12), fingerprintScope("fp-b", "pr-130"));
    const { core, calls } = counted(memory);

    const page = await listNativeBuilds(core, {
      channelId: `channel:${encodeChannelKey("pr-130")}`,
      limit: 20,
    });

    expect(page.data.map((row) => row.id)).toEqual([buildId(3), buildId(2)]);
    expect(calls).toEqual(["listNativeBuilds"]);
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
