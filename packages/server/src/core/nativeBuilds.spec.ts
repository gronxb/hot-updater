import {
  createMemoryAdapter,
  type DatabaseAdapter,
  DatabaseConstraintError,
  DatabaseRowReferencedError,
  type NativeBuildRegistration,
  ReleaseManagementError,
} from "@hot-updater/plugin-core";
import { encodeChannelKey, NIL_UUID } from "@hot-updater/protocol";
import {
  createBundleFixture,
  createBundleRowFixture,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { createInProcessCoreApi } from "./inProcess.testFixtures";

const buildId = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A release build's MIN_BUNDLE_ID: before the bundles deployed after it. */
const minBundleId = (n: number) =>
  `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const registration = (
  n: number,
  overrides: Partial<NativeBuildRegistration> = {},
): NativeBuildRegistration =>
  ({
    id: buildId(n),
    platform: "ios",
    channel: "production",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
    minBundleId: minBundleId(n),
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind: "ipa",
      storageUri: `storage://native-builds/ios/${buildId(n)}/App.ipa`,
      byteSize: 1_000 + n,
    },
    embeddedBundle: {
      manifestStorageUri: `storage://bundles/${minBundleId(n)}/manifest.json`,
      manifestFileHash: `manifest-hash-${n}`,
      assetBaseStorageUri: "storage://assets",
    },
    ...overrides,
  }) as NativeBuildRegistration;

const channelKey = encodeChannelKey("production");
const productionId = `channel:${channelKey}`;

const setup = () => {
  let clock = 1_000;
  return createInProcessCoreApi(createMemoryAdapter(), {
    now: () => (clock += 1),
  });
};

describe("the native build registry", () => {
  it("finds the newest build of a platform, channel, and fingerprint", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    const newest = await core.registerNativeBuild(registration(2));
    await core.registerNativeBuild(
      registration(3, { fingerprintHash: "fingerprint-b" }),
    );
    await core.registerNativeBuild(registration(4, { channel: "beta" }));
    await core.registerNativeBuild(
      registration(5, {
        platform: "android",
        artifact: {
          kind: "apk",
          storageUri: "storage://native-builds/android/app.apk",
          byteSize: 1,
        },
      }),
    );

    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      }),
    ).resolves.toEqual(newest);
    expect(newest).toMatchObject({
      id: buildId(2),
      platform: "ios",
      channel_id: productionId,
      fingerprint_hash: "fingerprint-a",
      app_version: null,
      min_bundle_id: minBundleId(2),
      artifact_kind: "ipa",
      byte_size: 1_002,
    });
    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "staging",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      }),
    ).resolves.toBeNull();
  });

  it("finds the newest build of a scope with a native build key", async () => {
    const core = setup();
    const key = (c: string) => `nbk1:${c.repeat(64)}`;
    const scope = {
      platform: "ios",
      channel: "production",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
    } as const;
    await core.registerNativeBuild(registration(1, { buildKey: key("a") }));
    const keyed = await core.registerNativeBuild(
      registration(2, { buildKey: key("a") }),
    );
    // Newer, but without a key, or with another one, or in another scope.
    await core.registerNativeBuild(registration(3));
    await core.registerNativeBuild(registration(4, { buildKey: key("b") }));
    await core.registerNativeBuild(
      registration(5, { channel: "beta", buildKey: key("a") }),
    );

    expect(keyed.build_key).toBe(key("a"));
    await expect(
      core.findNativeBuild(scope, { buildKey: key("a") }),
    ).resolves.toEqual(keyed);
    await expect(
      core.findNativeBuild(scope, { buildKey: key("c") }),
    ).resolves.toBeNull();
    await expect(core.findNativeBuild(scope)).resolves.toMatchObject({
      id: buildId(4),
    });
    await expect(
      core.findNativeBuild(scope, { buildKey: "nbk1:short" }),
    ).rejects.toThrow("Invalid native build key");
    await expect(
      core.registerNativeBuild(registration(6, { buildKey: "nbk2:x" })),
    ).rejects.toThrow("buildKey must be nbk1: and a SHA-256, or null");
  });

  it("finds a build of the app-version strategy by its exact app version", async () => {
    const core = setup();
    const build = await core.registerNativeBuild(
      registration(1, { fingerprintHash: null, appVersion: "1.2.0" }),
    );

    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: null,
        appVersion: "1.2.0",
      }),
    ).resolves.toEqual(build);
    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: null,
        appVersion: "1.2.1",
      }),
    ).resolves.toBeNull();
    // A fingerprint scope never matches an app version.
    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: "1.2.0",
        appVersion: null,
      }),
    ).resolves.toBeNull();
  });

  it("stores the built-in bundle as a bundle row the bundle totals leave out", async () => {
    const core = setup();
    await core.deploy([
      {
        bundle: createBundleFixture("1"),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]);
    await core.registerNativeBuild(
      registration(1, { gitCommitHash: "abc123" }),
    );

    await expect(core.getBundle(minBundleId(1))).resolves.toEqual({
      bundle: {
        id: minBundleId(1),
        platform: "ios",
        git_commit_hash: "abc123",
        metadata: {},
        manifest_storage_uri: `storage://bundles/${minBundleId(1)}/manifest.json`,
        manifest_file_hash: "manifest-hash-1",
        asset_base_storage_uri: "storage://assets",
      },
      patches: [],
      childCount: 0,
    });
    await expect(core.countBundles()).resolves.toBe(1);
    await expect(core.countBundles("ios")).resolves.toBe(1);
    // No release publishes it, so no catalog lists it.
    await expect(
      core.listReleases({
        filter: { kind: "bundle", bundleId: minBundleId(1) },
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(core.listChannels()).resolves.toEqual([
      { id: productionId, name: "production" },
    ]);
  });

  it("refuses a build whose ID or built-in bundle is already registered", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));

    await expect(
      core.registerNativeBuild(
        registration(2, { minBundleId: minBundleId(1) }),
      ),
    ).rejects.toThrow(DatabaseConstraintError);
    await expect(
      core.registerNativeBuild(
        registration(1, { minBundleId: minBundleId(2) }),
      ),
    ).rejects.toThrow(DatabaseConstraintError);
    await expect(core.getBundle(minBundleId(2))).resolves.toBeNull();
    await expect(core.listNativeBuilds({ limit: 10 })).resolves.toHaveLength(1);
  });

  it("refuses a debug build, which has no built-in bundle, and a scope without one target", async () => {
    const core = setup();

    await expect(
      core.registerNativeBuild(registration(1, { minBundleId: NIL_UUID })),
    ).rejects.toThrow("minBundleId must be the UUIDv7");
    await expect(
      core.registerNativeBuild(registration(1, { appVersion: "1.0.0" })),
    ).rejects.toThrow("exactly one of fingerprintHash and appVersion");
    await expect(
      core.registerNativeBuild(
        registration(1, {
          platform: "android",
          artifact: {
            kind: "ipa",
            storageUri: "storage://App.ipa",
            byteSize: 1,
          },
        }),
      ),
    ).rejects.toThrow("artifact.kind of an android build must be apk or aab");
    await expect(
      core.registerNativeBuild(
        registration(1, {
          artifact: {
            kind: "aab",
            storageUri: "storage://app.aab",
            byteSize: 1,
          },
        }),
      ),
    ).rejects.toThrow("artifact.kind of an ios build must be ipa or app");
    await expect(
      core.registerNativeBuild(
        registration(1, { gitCommitHash: "a".repeat(256) }),
      ),
    ).rejects.toThrow("gitCommitHash must be at most 255 characters");
    await expect(core.listChannels()).resolves.toEqual([]);
    await expect(core.listNativeBuilds({ limit: 10 })).resolves.toEqual([]);
  });

  it("keeps a built-in bundle from deletion and from a release", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));

    await expect(core.deleteBundles([minBundleId(1)])).rejects.toThrow(
      DatabaseRowReferencedError,
    );
    await expect(
      core.deploy([
        {
          bundleId: minBundleId(1),
          release: {
            channel: "production",
            enabled: true,
            fingerprintHash: "fingerprint-a",
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: null,
          },
        },
      ]),
    ).rejects.toThrow(ReleaseManagementError);
    await expect(core.getBundle(minBundleId(1))).resolves.not.toBeNull();
    await expect(core.countBundles()).resolves.toBe(0);
    await expect(
      core.listReleases({ filter: { kind: "all" }, limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("keeps a channel its native builds use from deletion", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1, { channel: "beta" }));
    const beta = await core.findChannelByName("beta");

    await expect(core.deleteChannel(beta!.id)).resolves.toEqual({
      deleted: false,
      reason: "not_empty",
    });
    const unused = await core.ensureChannel("unused");
    await expect(core.deleteChannel(unused.id)).resolves.toEqual({
      deleted: true,
    });
  });

  it("deletes a build with its built-in bundle and the patches from it, leaving the totals", async () => {
    const core = setup();
    const bundle = createBundleFixture("1");
    await core.deploy([
      {
        bundle,
        release: {
          channel: "beta",
          enabled: true,
          fingerprintHash: "fingerprint-a",
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);
    const build = await core.registerNativeBuild(
      registration(1, { channel: "beta" }),
    );
    const kept = await core.registerNativeBuild(registration(2));
    await core.updateBundle(bundle.id, {
      patches: [
        {
          baseBundleId: minBundleId(1),
          baseFileHash: "base-hash",
          byteSize: 42,
          patchFileHash: "patch-hash",
          patchStorageUri: `storage://patches/${bundle.id}.patch`,
        },
      ],
    });

    await expect(core.deleteNativeBuild(build.id)).resolves.toEqual({
      deleted: true,
      nativeBuild: build,
    });

    await expect(core.getNativeBuild(build.id)).resolves.toBeNull();
    await expect(core.getBundle(minBundleId(1))).resolves.toBeNull();
    await expect(
      core.listPatchesFromBase(minBundleId(1), { limit: 10 }),
    ).resolves.toEqual([]);
    await expect(core.getBundle(bundle.id)).resolves.toMatchObject({
      patches: [],
    });
    await expect(core.countBundles()).resolves.toBe(1);
    await expect(core.countBundles("ios")).resolves.toBe(1);
    await expect(core.getNativeBuild(kept.id)).resolves.toEqual(kept);
    // Its channel keeps its release, and no build keeps it any more.
    const beta = await core.findChannelByName("beta");
    await expect(core.deleteChannel(beta!.id)).resolves.toEqual({
      deleted: false,
      reason: "not_empty",
    });
    await core.registerNativeBuild(registration(3, { channel: "qa" }));
    const qa = await core.findChannelByName("qa");
    await core.deleteNativeBuild(buildId(3));
    await expect(core.deleteChannel(qa!.id)).resolves.toEqual({
      deleted: true,
    });
  });

  it("answers not_found for a build that is not registered", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.deleteNativeBuild(buildId(1));

    await expect(core.deleteNativeBuild(buildId(1))).resolves.toEqual({
      deleted: false,
      reason: "not_found",
    });
    await expect(core.deleteNativeBuild(buildId(9))).resolves.toEqual({
      deleted: false,
      reason: "not_found",
    });
  });

  it("ensures the channel again when it is deleted between ensuring it and the registration", async () => {
    const memory = createMemoryAdapter();
    const direct = createInProcessCoreApi(memory);
    let raced = false;
    const adapter: DatabaseAdapter = {
      ...memory,
      write: async (ops) => {
        if (
          !raced &&
          ops.some(
            (op) => op.type === "insert" && op.table.name === "native_builds",
          )
        ) {
          raced = true;
          const channel = await direct.findChannelByName("production");
          await direct.deleteChannel(channel!.id);
        }
        return memory.write(ops);
      },
    };
    const core = createInProcessCoreApi(adapter);

    const build = await core.registerNativeBuild(registration(1));

    expect(raced).toBe(true);
    await expect(core.findChannelByName("production")).resolves.toEqual({
      id: build.channel_id,
      name: "production",
    });
    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      }),
    ).resolves.toEqual(build);
  });

  it("keeps a built-in bundle out of the totals when its platform changes", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));

    await core.updateBundle(minBundleId(1), { platform: "android" });

    await expect(core.getBundle(minBundleId(1))).resolves.toMatchObject({
      bundle: { platform: "android" },
    });
    await expect(core.countBundles("ios")).resolves.toBe(0);
    await expect(core.countBundles("android")).resolves.toBe(0);
    await expect(core.countBundles()).resolves.toBe(0);
  });

  it("lists builds by ID, a page at a time", async () => {
    const core = setup();
    for (const n of [1, 2, 3]) await core.registerNativeBuild(registration(n));

    const first = await core.listNativeBuilds({ limit: 2, order: "desc" });
    expect(first.map(({ id }) => id)).toEqual([buildId(3), buildId(2)]);
    const second = await core.listNativeBuilds({
      limit: 2,
      order: "desc",
      after: first.at(-1)!.id,
    });
    expect(second.map(({ id }) => id)).toEqual([buildId(1)]);
  });

  it("lists only the builds that embed a channel, a page at a time", async () => {
    const core = setup();
    const onChannel = { pr: [1, 3, 4], production: [2, 5] } as const;
    for (const n of [1, 2, 3, 4, 5]) {
      await core.registerNativeBuild(
        registration(n, {
          channel: onChannel.pr.includes(n as 1 | 3 | 4)
            ? "pr-130"
            : "production",
        }),
      );
    }
    const prId = `channel:${encodeChannelKey("pr-130")}`;

    const first = await core.listNativeBuilds({
      channelId: prId,
      limit: 2,
      order: "desc",
    });
    const second = await core.listNativeBuilds({
      channelId: prId,
      limit: 2,
      order: "desc",
      after: first.at(-1)!.id,
    });
    const production = await core.listNativeBuilds({
      channelId: productionId,
      limit: 10,
    });

    // The channel's own registrations, newest first; none from production.
    expect([...first, ...second].map(({ id }) => id)).toEqual(
      [...onChannel.pr].reverse().map(buildId),
    );
    expect(production.map(({ id }) => id)).toEqual(
      onChannel.production.map(buildId),
    );
    // A channel no build embeds, or no channel at all, lists none.
    await expect(
      core.listNativeBuilds({
        channelId: `channel:${encodeChannelKey("pr-999")}`,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await core.ensureChannel("staging");
    await expect(
      core.listNativeBuilds({
        channelId: `channel:${encodeChannelKey("staging")}`,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});

describe("a built-in bundle row and released SDKs", () => {
  // A device on a release build reports its MIN_BUNDLE_ID as its current
  // bundle, which the server already looks up. Registering the build makes
  // that row exist; without patches from it, every answer stays the same.
  const target = createBundleRowFixture("302");
  const current = createBundleRowFixture("301").id;
  const assetBaseStorageUri = "storage://test-bucket/assets";

  it("answers the update check and every artifact route the same", async () => {
    const hotUpdater = createHotUpdater({
      database: { name: "memory", adapter: createMemoryAdapter() },
      storage: createReleaseCatalogTestStorage(),
      plugins: [],
      clientAccess: "public",
    });
    const { core } = hotUpdater;
    const release = {
      channel: "production",
      enabled: true,
      message: null,
      shouldForceUpdate: false,
    };
    await core.deploy([
      {
        bundle: {
          id: target.id,
          platform: "ios",
          gitCommitHash: null,
          metadata: {},
          manifestStorageUri: target.manifest_storage_uri,
          manifestFileHash: target.manifest_file_hash,
          assetBaseStorageUri,
        },
        release: {
          ...release,
          fingerprintHash: null,
          targetAppVersion: "1.0.0",
        },
      },
      {
        bundle: { ...createBundleFixture("303"), assetBaseStorageUri },
        release: {
          ...release,
          fingerprintHash: "fingerprint-a",
          targetAppVersion: null,
        },
      },
    ]);
    const answers = () =>
      Promise.all(
        [
          [`/release-catalogs/app-version/ios/${channelKey}/1.0.0`],
          [`/release-catalogs/fingerprint/ios/${channelKey}/fingerprint-a`],
          [`/artifacts/v1/${target.id}/from/${current}`],
          [`/artifacts/v2/${target.id}/from/${current}`],
          [
            `/artifacts/v2/${target.id}/files`,
            {
              method: "POST",
              body: JSON.stringify({ paths: ["index.ios.bundle"] }),
              headers: { "content-type": "application/json" },
            },
          ],
        ].map(async ([path, init]) => {
          const response = await hotUpdater.handlers.client(
            new Request(`http://localhost${path}`, init as RequestInit),
          );
          return {
            path,
            status: response.status,
            cacheControl: response.headers.get("cache-control"),
            body: await response.text(),
          };
        }),
      );

    const without = await answers();
    await core.registerNativeBuild(
      registration(1, {
        minBundleId: current,
        embeddedBundle: {
          manifestStorageUri: `storage://bundles/${current}/manifest.json`,
          manifestFileHash: "built-in-manifest-hash",
          assetBaseStorageUri,
        },
      }),
    );
    await expect(core.getBundle(current)).resolves.not.toBeNull();

    expect(without.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    await expect(answers()).resolves.toEqual(without);
  });
});
