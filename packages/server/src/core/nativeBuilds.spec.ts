import {
  createEngine,
  createKvAdapter,
  createMemoryAdapter,
  type DatabaseAdapter,
  meterReads,
  DatabaseConstraintError,
  DatabaseRowReferencedError,
  type NativeBuildRegistration,
  ReleaseManagementError,
} from "@hot-updater/plugin-core";
import { encodeChannelKey, NIL_UUID } from "@hot-updater/protocol";
import {
  createBundleFixture,
  createBundleRowFixture,
  createMemoryKeyValueStore,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { createCoreApi } from "./api";
import { createInProcessCoreApi } from "./inProcess.testFixtures";
import { NativeBuildInputError } from "./nativeBuilds";

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

/**
 * A sandbox build's registration: on a pull request's channel like any build,
 * with what its artifact says of it.
 */
const sandboxRegistration = (
  n: number,
  overrides: Partial<NativeBuildRegistration> = {},
): NativeBuildRegistration =>
  registration(n, {
    channel: "pr-134",
    isSandbox: true,
    sandboxUrlScheme: "acme-preview",
    sandboxAppId: "com.example.app",
    exportMethod: "ad-hoc",
    ...overrides,
  });

/** The sandbox scope a lookup of `sandboxRegistration`'s builds names. */
const sandboxScope = {
  platform: "ios",
  channel: "pr-140",
  fingerprintHash: "fingerprint-a",
  appVersion: null,
  sandbox: {
    appId: "com.example.app",
    urlScheme: "acme-preview",
    artifactKind: "ipa",
    distribution: "direct",
  },
} as const;

const channelKey = encodeChannelKey("production");
const productionId = `channel:${channelKey}`;

const setup = () => {
  let clock = 1_000;
  return createInProcessCoreApi(createMemoryAdapter(), {
    now: () => (clock += 1),
  });
};

/** Core's API over an engine the spec also writes rows through directly. */
const setupWithDb = () => {
  let clock = 1_000;
  const db = createEngine({
    name: "in-process",
    adapter: createMemoryAdapter(),
  }).core;
  const core = createCoreApi(
    db,
    { resolveFileUrl: async () => null },
    { now: () => (clock += 1) },
  );
  return { core, db };
};

/** Core's API over a memory adapter whose reads `measureReads` reports. */
const setupMetered = () => {
  let clock = 1_000;
  const database = meterReads({
    name: "memory",
    adapter: createMemoryAdapter(),
  });
  const core = createCoreApi(
    createEngine(database).core,
    { resolveFileUrl: async () => null },
    { now: () => (clock += 1) },
  );
  return { core, measureReads: database.measureReads };
};

const setRow = (
  db: ReturnType<typeof setupWithDb>["db"],
  id: string,
  set: Record<string, unknown>,
) =>
  db.transaction(async (tx) => {
    const row = await tx.findOne("native_builds", { id });
    if (row === null) throw new Error(`no native build ${id}`);
    tx.update("native_builds", row, set as never);
  });

describe("the native build registry", () => {
  it("records a sandbox build, and no other", async () => {
    const core = setup();
    const sandboxBuild = await core.registerNativeBuild(sandboxRegistration(1));
    const plain = await core.registerNativeBuild(registration(2));

    expect(sandboxBuild.is_sandbox).toBe(true);
    expect(plain.is_sandbox).toBe(false);
    expect(plain.is_store_build).toBe(false);
    expect(await core.getNativeBuild(buildId(1))).toEqual(sandboxBuild);
    expect(await core.getNativeBuild(buildId(2))).toEqual(plain);
    expect(await core.findNativeBuild(sandboxScope)).toEqual(sandboxBuild);
  });

  it.each([
    [
      "a sandbox build without its URL scheme",
      { isSandbox: true, sandboxAppId: "com.example.app" },
      "a sandbox build needs the sandboxUrlScheme its artifact registers",
    ],
    [
      "a sandbox build without its app ID",
      { isSandbox: true, sandboxUrlScheme: "acme-preview" },
      "a sandbox build needs the sandboxAppId its artifact reports, which an older hot-updater CLI doesn't send. Upgrade the hot-updater CLI to the version that matches this server, and build again",
    ],
    [
      "a sandbox app ID that isn't one",
      {
        isSandbox: true,
        sandboxUrlScheme: "acme-preview",
        sandboxAppId: "com example",
      },
      "sandboxAppId must be the artifact's bundle identifier or application ID, up to 255 characters",
    ],
    [
      "a sandbox app ID on a build of no sandbox",
      { channel: "production", sandboxAppId: "com.example.app" },
      "sandboxAppId is a sandbox build's, and this isn't one",
    ],
    [
      "a null record",
      { channel: "sandbox-release", isSandbox: null },
      "isSandbox must be true or false",
    ],
    [
      "a record that isn't a boolean",
      { channel: "production", isSandbox: "yes" },
      "isSandbox must be true or false",
    ],
    [
      "a sandbox URL scheme on a build of no sandbox",
      { channel: "production", sandboxUrlScheme: "acme-preview" },
      "sandboxUrlScheme is a sandbox build's, and this isn't one",
    ],
    ...(
      [
        "Acme",
        "1app",
        "acme_preview",
        "acme://",
        "",
        `a${"b".repeat(255)}`,
        42,
      ] as const
    ).map(
      (sandboxUrlScheme) =>
        [
          `a sandbox URL scheme of ${JSON.stringify(sandboxUrlScheme)}`,
          {
            isSandbox: true,
            sandboxAppId: "com.example.app",
            sandboxUrlScheme,
          },
          "sandboxUrlScheme must be a URL scheme in lower case, up to 255 characters, or null",
        ] as const,
    ),
  ] as const)("refuses %s", async (_, overrides, message) => {
    const core = setup();
    await expect(
      core.registerNativeBuild(
        registration(1, overrides as Partial<NativeBuildRegistration>),
      ),
    ).rejects.toThrow(
      new NativeBuildInputError(`Invalid native build: ${message}.`),
    );
    expect(await core.getNativeBuild(buildId(1))).toBeNull();
  });

  it("records the URL scheme a sandbox build's artifact registers, and null on any other build", async () => {
    const core = setup();
    const custom = await core.registerNativeBuild(
      sandboxRegistration(1, { sandboxUrlScheme: "acme.preview+qa" }),
    );
    const plain = await core.registerNativeBuild(
      registration(3, { sandboxUrlScheme: null }),
    );

    expect(custom.sandbox_url_scheme).toBe("acme.preview+qa");
    expect(plain.sandbox_url_scheme).toBeNull();
    expect(await core.getNativeBuild(buildId(1))).toEqual(custom);
  });

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

  it("takes no patch from a sandbox build's built-in bundle, and keeps one already stored", async () => {
    const { core, db } = setupWithDb();
    const bundle = createBundleFixture("1");
    await core.deploy([
      {
        bundle,
        release: {
          channel: "pr-134",
          enabled: true,
          fingerprintHash: "fingerprint-a",
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);
    await core.registerNativeBuild(sandboxRegistration(1));
    await core.registerNativeBuild(registration(2));
    await core.registerNativeBuild(registration(3));
    const patchFrom = (n: number) => ({
      baseBundleId: minBundleId(n),
      baseFileHash: `base-hash-${n}`,
      byteSize: 42,
      patchFileHash: `patch-hash-${n}`,
      patchStorageUri: `storage://patches/${bundle.id}/${n}.patch`,
    });

    await expect(
      core.updateBundle(bundle.id, { patches: [patchFrom(1)] }),
    ).rejects.toThrow(
      new NativeBuildInputError(
        "A sandbox build's built-in bundle is no patch base.",
      ),
    );
    await expect(
      core.listPatchesFromBase(minBundleId(1), { limit: 10 }),
    ).resolves.toEqual([]);
    // Nor does a deploy write a new bundle with one.
    const deployed = createBundleFixture("2");
    await expect(
      core.deploy([
        {
          bundle: { ...deployed, patches: [patchFrom(1)] },
          release: {
            channel: "pr-134",
            enabled: true,
            fingerprintHash: "fingerprint-a",
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: null,
          },
        },
      ]),
    ).rejects.toThrow(
      new NativeBuildInputError(
        "A sandbox build's built-in bundle is no patch base.",
      ),
    );
    await expect(core.getBundle(deployed.id)).resolves.toBeNull();
    await expect(
      core.listPatchesFromBase(minBundleId(1), { limit: 10 }),
    ).resolves.toEqual([]);

    // A patch stored before the refusal stays through later updates.
    await core.updateBundle(bundle.id, { patches: [patchFrom(2)] });
    await setRow(db, buildId(2), { is_sandbox: true });
    await core.updateBundle(bundle.id, {
      patches: [patchFrom(2), patchFrom(3)],
    });
    expect(
      (await core.getBundle(bundle.id))?.patches.map(
        ({ base_bundle_id }) => base_bundle_id,
      ),
    ).toEqual(expect.arrayContaining([minBundleId(2), minBundleId(3)]));
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

  it("records a store submission on the build's row, which every read returns", async () => {
    const core = setup();
    const ios = await core.registerNativeBuild(registration(1));
    const android = await core.registerNativeBuild(
      registration(2, {
        platform: "android",
        artifact: {
          kind: "aab",
          storageUri: "storage://app.aab",
          byteSize: 1,
        },
      }),
    );
    // A registration records no submission.
    expect(ios).toMatchObject({
      submitted_to: null,
      submitted_at_ms: null,
      submitted_version: null,
    });

    const recorded = await core.recordNativeBuildSubmission(ios.id, {
      destination: "testflight",
      version: "1.7.0 (66)",
    });
    await core.recordNativeBuildSubmission(android.id, {
      destination: "play-internal",
      version: "1.7.0 (66)",
    });

    expect(recorded).toEqual({
      ...ios,
      submitted_to: "testflight",
      submitted_at_ms: expect.any(Number),
      submitted_version: "1.7.0 (66)",
    });
    expect(recorded!.submitted_at_ms!).toBeGreaterThan(ios.created_at_ms);
    await expect(core.getNativeBuild(ios.id)).resolves.toEqual(recorded);
    await expect(
      core.listNativeBuilds({ limit: 10, order: "desc" }),
    ).resolves.toMatchObject([
      { id: android.id, submitted_to: "play-internal" },
      { id: ios.id, submitted_to: "testflight" },
    ]);
  });

  it.each(["play-closed", "play-open", "play-production"] as const)(
    "records promotion to %s",
    async (destination) => {
      const core = setup();
      const build = await core.registerNativeBuild(
        registration(1, {
          platform: "android",
          artifact: {
            kind: "aab",
            storageUri: "storage://app.aab",
            byteSize: 1,
          },
        }),
      );
      await core.recordNativeBuildSubmission(build.id, {
        destination: "play-internal",
        version: "1.7.0 (63)",
      });
      await core.recordNativeBuildSubmission(build.id, {
        destination,
        version: "1.7.0 (63)",
      });
      await expect(core.getNativeBuild(build.id)).resolves.toMatchObject({
        submitted_to: destination,
        submitted_version: "1.7.0 (63)",
      });
    },
  );

  it("stores the build number the artifact reports, and none for a registration without one", async () => {
    const core = setup();
    const numbered = await core.registerNativeBuild(
      registration(1, { buildNumber: "66" }),
    );
    // A CLI that predates build numbers leaves the field out.
    const { buildNumber: _none, ...older } = registration(2);
    const unnumbered = await core.registerNativeBuild(older);

    expect(numbered.build_number).toBe("66");
    expect(unnumbered.build_number).toBeNull();
    await expect(core.getNativeBuild(numbered.id)).resolves.toMatchObject({
      build_number: "66",
    });
    await expect(
      core.registerNativeBuild(registration(3, { buildNumber: " " })),
    ).rejects.toThrow("buildNumber must be the artifact's build number");
  });

  it("refuses a submission to another platform's store or without a version, and answers null for an unknown build", async () => {
    const core = setup();
    const ios = await core.registerNativeBuild(registration(1));

    await expect(
      core.recordNativeBuildSubmission(ios.id, {
        destination: "play-internal",
        version: "1.7.0 (66)",
      }),
    ).rejects.toThrow(
      "an ios build is submitted to testflight, not play-internal",
    );
    await expect(
      core.recordNativeBuildSubmission(ios.id, {
        destination: "testflight",
        version: " ",
      }),
    ).rejects.toThrow(NativeBuildInputError);
    await expect(
      core.recordNativeBuildSubmission(buildId(9), {
        destination: "testflight",
        version: "1.7.0 (66)",
      }),
    ).resolves.toBeNull();
    // Nothing was written.
    await expect(core.getNativeBuild(ios.id)).resolves.toEqual(ios);
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

describe("the store build mark", () => {
  const scope = {
    platform: "ios",
    channel: "production",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
  } as const;
  const marksIn = async (core: ReturnType<typeof setup>) =>
    (await core.listNativeBuilds({ limit: 100 }))
      .filter((build) => build.is_store_build)
      .map(({ id }) => id);

  it("marks a build, which the scope's read finds and the newest read ignores", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.registerNativeBuild(registration(2));
    expect(await core.findNativeBuild(scope, { storeBuild: true })).toBeNull();

    const marked = await core.markNativeBuild(buildId(1), { storeBuild: true });

    expect(marked).toMatchObject({
      nativeBuild: { id: buildId(1), is_store_build: true },
      previous: null,
    });
    expect(
      await core.findNativeBuild(scope, { storeBuild: true }),
    ).toMatchObject({ id: buildId(1), is_store_build: true });
    expect(await core.findNativeBuild(scope)).toMatchObject({
      id: buildId(2),
      is_store_build: false,
    });
    expect(await core.getNativeBuild(buildId(1))).toMatchObject({
      is_store_build: true,
    });
  });

  it("lets any number of a scope's builds hold no mark", async () => {
    const core = setup();
    for (const n of [1, 2, 3]) await core.registerNativeBuild(registration(n));

    expect(
      (await core.listNativeBuilds({ limit: 100 })).map(
        ({ is_store_build }) => is_store_build,
      ),
    ).toEqual([false, false, false]);
    await core.markNativeBuild(buildId(2), { storeBuild: true });
    expect(await marksIn(core)).toEqual([buildId(2)]);
  });

  it("keeps the scope's store build slot on the marked row alone", async () => {
    const { core, db } = setupWithDb();
    const slotOf = async (n: number) =>
      (await db.findOne("native_builds", { id: buildId(n) }))
        ?.store_build_scope_key ?? null;
    const first = await core.registerNativeBuild(registration(1));
    await core.registerNativeBuild(registration(2));
    expect([await slotOf(1), await slotOf(2)]).toEqual([null, null]);

    await core.markNativeBuild(buildId(1), { storeBuild: true });
    expect([await slotOf(1), await slotOf(2)]).toEqual([first.scope_key, null]);
    expect(
      await db.findOne("native_builds", {
        store_build_scope_key: first.scope_key,
      }),
    ).toMatchObject({ id: buildId(1), is_store_build: true });

    await core.markNativeBuild(buildId(2), { storeBuild: true });
    expect([await slotOf(1), await slotOf(2)]).toEqual([null, first.scope_key]);

    await core.markNativeBuild(buildId(2), { storeBuild: false });
    expect([await slotOf(1), await slotOf(2)]).toEqual([null, null]);
  });

  it("leaves one mark when first marks race", async () => {
    const core = setup();
    for (const n of [1, 2, 3, 4])
      await core.registerNativeBuild(registration(n));

    const results = await Promise.all(
      [1, 2, 3, 4, 1].map((n) =>
        core.markNativeBuild(buildId(n), { storeBuild: true }),
      ),
    );

    expect(results.map((result) => result?.nativeBuild.is_store_build)).toEqual(
      [true, true, true, true, true],
    );
    const marks = await marksIn(core);
    expect(marks).toHaveLength(1);
    expect(
      await core.findNativeBuild(scope, { storeBuild: true }),
    ).toMatchObject({ id: marks[0], is_store_build: true });
  });

  it("replaces the scope's mark, so one build holds it", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.registerNativeBuild(registration(2));
    await core.markNativeBuild(buildId(1), { storeBuild: true });

    const replaced = await core.markNativeBuild(buildId(2), {
      storeBuild: true,
    });

    expect(replaced).toMatchObject({
      nativeBuild: { id: buildId(2), is_store_build: true },
      previous: { id: buildId(1), is_store_build: false },
    });
    expect(await marksIn(core)).toEqual([buildId(2)]);
  });

  it("keeps a mark to its own scope", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.registerNativeBuild(
      registration(2, { fingerprintHash: "fingerprint-b" }),
    );
    await core.registerNativeBuild(registration(3, { channel: "beta" }));
    await core.registerNativeBuild(
      registration(4, {
        platform: "android",
        artifact: {
          kind: "aab",
          storageUri: "storage://native-builds/android/4/App.aab",
          byteSize: 1,
        },
      }),
    );
    await core.registerNativeBuild(
      registration(5, { fingerprintHash: null, appVersion: "1.0.0" }),
    );
    await core.registerNativeBuild(
      registration(6, { fingerprintHash: null, appVersion: "1.1.0" }),
    );

    for (const n of [1, 2, 3, 4, 5, 6]) {
      await core.markNativeBuild(buildId(n), { storeBuild: true });
    }

    expect(await marksIn(core)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => buildId(n)),
    );
    expect(
      await core.findNativeBuild(
        { ...scope, fingerprintHash: null, appVersion: "1.0.0" },
        { storeBuild: true },
      ),
    ).toMatchObject({ id: buildId(5) });
  });

  it("clears a mark, and marking again changes nothing", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.markNativeBuild(buildId(1), { storeBuild: true });

    expect(
      await core.markNativeBuild(buildId(1), { storeBuild: true }),
    ).toMatchObject({
      nativeBuild: { id: buildId(1), is_store_build: true },
      previous: null,
    });
    expect(
      await core.markNativeBuild(buildId(1), { storeBuild: false }),
    ).toMatchObject({
      nativeBuild: { id: buildId(1), is_store_build: false },
      previous: null,
    });
    expect(
      await core.markNativeBuild(buildId(1), { storeBuild: false }),
    ).toMatchObject({ nativeBuild: { is_store_build: false } });
    expect(await core.findNativeBuild(scope, { storeBuild: true })).toBeNull();
    // Clearing a build that doesn't hold the mark leaves the one that does.
    await core.registerNativeBuild(registration(2));
    await core.markNativeBuild(buildId(2), { storeBuild: true });
    await core.markNativeBuild(buildId(1), { storeBuild: false });
    expect(await marksIn(core)).toEqual([buildId(2)]);
  });

  it("refuses a sandbox build, and answers null for an unknown one", async () => {
    const core = setup();
    await core.registerNativeBuild(sandboxRegistration(1));

    await expect(
      core.markNativeBuild(buildId(1), { storeBuild: true }),
    ).rejects.toThrow(NativeBuildInputError);
    expect(await marksIn(core)).toEqual([]);
    // Clearing asks nothing of a store.
    await expect(
      core.markNativeBuild(buildId(1), { storeBuild: false }),
    ).resolves.toMatchObject({ nativeBuild: { is_store_build: false } });
    expect(
      await core.markNativeBuild(buildId(9), { storeBuild: true }),
    ).toBeNull();
  });

  it("refuses a build by its sandbox record, not by its channel", async () => {
    const { core, db } = setupWithDb();
    await core.registerNativeBuild(registration(1, { channel: "pr-130" }));
    await core.registerNativeBuild(sandboxRegistration(2));
    // Rows no registration writes: a normal build recorded as a sandbox build,
    // and the reverse.
    await setRow(db, buildId(1), { is_sandbox: true });
    await setRow(db, buildId(2), { is_sandbox: false });

    await expect(
      core.markNativeBuild(buildId(1), { storeBuild: true }),
    ).rejects.toThrow("A sandbox build can't be the store build.");
    await expect(
      core.markNativeBuild(buildId(2), { storeBuild: true }),
    ).resolves.toMatchObject({
      nativeBuild: { id: buildId(2), is_store_build: true, is_sandbox: false },
    });
  });

  it.each(["play-closed", "play-open", "play-production"] as const)(
    "refuses sandbox submission to %s",
    async (destination) => {
      const core = setup();
      const build = await core.registerNativeBuild(
        registration(1, {
          platform: "android",
          channel: "pr-134",
          isSandbox: true,
          sandboxUrlScheme: "acme-preview",
          sandboxAppId: "com.example.app.sandbox",
          artifact: {
            kind: "aab",
            storageUri: "storage://app.aab",
            byteSize: 1,
          },
        }),
      );
      await core.recordNativeBuildSubmission(build.id, {
        destination: "play-internal",
        version: "1.0 (1)",
      });
      await expect(
        core.recordNativeBuildSubmission(build.id, {
          destination,
          version: "1.0 (1)",
        }),
      ).rejects.toThrow("sandbox");
      expect(await core.getNativeBuild(build.id)).toMatchObject({
        submitted_to: "play-internal",
      });
    },
  );

  it("keeps a sandbox build's record through its submission", async () => {
    const core = setup();
    await core.registerNativeBuild(sandboxRegistration(1));
    await expect(
      core.recordNativeBuildSubmission(buildId(1), {
        destination: "testflight",
        version: "1.0.0 (1)",
      }),
    ).resolves.toMatchObject({ is_sandbox: true, submitted_to: "testflight" });
    expect(await core.getNativeBuild(buildId(1))).toMatchObject({
      is_sandbox: true,
      submitted_to: "testflight",
    });
  });

  it("drops the mark with a deleted build, and the scope can be marked again", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.registerNativeBuild(registration(2));
    await core.markNativeBuild(buildId(1), { storeBuild: true });

    await core.deleteNativeBuild(buildId(1));

    expect(await core.findNativeBuild(scope, { storeBuild: true })).toBeNull();
    await core.markNativeBuild(buildId(2), { storeBuild: true });
    expect(
      await core.findNativeBuild(scope, { storeBuild: true }),
    ).toMatchObject({ id: buildId(2) });
  });

  it("keeps the mark through a store submission and a new registration", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.markNativeBuild(buildId(1), { storeBuild: true });

    await core.recordNativeBuildSubmission(buildId(1), {
      destination: "testflight",
      version: "1.0.0 (1)",
    });
    await core.registerNativeBuild(registration(2));

    expect(
      await core.findNativeBuild(scope, { storeBuild: true }),
    ).toMatchObject({ id: buildId(1), submitted_to: "testflight" });
  });

  it("leaves one mark when marks of a scope race, with none before them", async () => {
    const core = setup();
    const builds = [1, 2, 3, 4, 5, 6];
    for (const n of builds) await core.registerNativeBuild(registration(n));

    const results = await Promise.all(
      builds.map((n) => core.markNativeBuild(buildId(n), { storeBuild: true })),
    );

    expect(results.every((result) => result !== null)).toBe(true);
    expect(await marksIn(core)).toHaveLength(1);
  });

  it("leaves one mark when marks of a scope race to replace one", async () => {
    const core = setup();
    const builds = [1, 2, 3, 4, 5, 6];
    for (const n of builds) await core.registerNativeBuild(registration(n));
    await core.markNativeBuild(buildId(1), { storeBuild: true });

    await Promise.all(
      builds
        .slice(1)
        .map((n) => core.markNativeBuild(buildId(n), { storeBuild: true })),
    );

    const marks = await marksIn(core);
    expect(marks).toHaveLength(1);
    expect(marks).not.toContain(buildId(1));
  });

  it("finds a build older than a bundle past pages of newer builds in the way", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    for (let n = 2; n <= 12; n += 1) {
      await core.registerNativeBuild(
        registration(n, {
          minBundleId: `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
        }),
      );
    }

    expect(
      await core.findNativeBuild(scope, {
        builtInOlderThan: "01950000-0000-7000-8000-000000000000",
      }),
    ).toMatchObject({ id: buildId(1) });
    expect(
      await core.findNativeBuild(scope, {
        builtInOlderThan: "01800000-0000-7000-8000-000000000000",
      }),
    ).toBeNull();
  });

  it("reads as much for a build older than a bundle however many newer builds are in the way", async () => {
    /** The reads of a lookup past `newer` builds made after the bundle. */
    const readsPast = async (newer: number) => {
      const { core, measureReads } = setupMetered();
      await core.registerNativeBuild(registration(1));
      for (let n = 2; n <= newer + 1; n += 1) {
        await core.registerNativeBuild(
          registration(n, {
            minBundleId: `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
          }),
        );
      }
      const { adapter } = await measureReads(() =>
        core.findNativeBuild(scope, {
          builtInOlderThan: "01950000-0000-7000-8000-000000000000",
        }),
      );
      return adapter;
    };

    expect(await readsPast(300)).toEqual(await readsPast(150));
  });

  it("finds a build older than a bundle behind up to 100 builds before the newest, and none behind more", async () => {
    const findPast = async (newer: number) => {
      const core = setup();
      await core.registerNativeBuild(registration(1));
      for (let n = 2; n <= newer + 1; n += 1) {
        await core.registerNativeBuild(
          registration(n, {
            minBundleId: `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
          }),
        );
      }
      return core.findNativeBuild(scope, {
        builtInOlderThan: "01950000-0000-7000-8000-000000000000",
      });
    };

    // Build 1 is the 100th build before the newest, then the 101st.
    expect(await findPast(100)).toMatchObject({ id: buildId(1) });
    expect(await findPast(101)).toBeNull();
  });

  it("keeps a build key through the builds newer than the bundle", async () => {
    const core = setup();
    const keyA = `nbk1:${"a".repeat(64)}`;
    const keyB = `nbk1:${"b".repeat(64)}`;
    await core.registerNativeBuild(registration(1, { buildKey: keyA }));
    await core.registerNativeBuild(registration(2, { buildKey: keyB }));
    await core.registerNativeBuild(
      registration(3, {
        buildKey: keyA,
        minBundleId: `019a0000-0000-7000-8000-${"3".repeat(12)}`,
      }),
    );

    expect(
      await core.findNativeBuild(scope, {
        buildKey: keyA,
        builtInOlderThan: "01950000-0000-7000-8000-000000000000",
      }),
    ).toMatchObject({ id: buildId(1), build_key: keyA });
  });

  it("finds the newest build older than a bundle, past builds newer than it", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    await core.registerNativeBuild(registration(2));
    await core.registerNativeBuild(
      registration(3, {
        minBundleId: `019a0000-0000-7000-8000-${"3".repeat(12)}`,
      }),
    );
    await core.registerNativeBuild(
      registration(4, {
        minBundleId: `019a0000-0000-7000-8000-${"4".repeat(12)}`,
      }),
    );
    const bundleId = "01950000-0000-7000-8000-000000000000";

    expect(
      await core.findNativeBuild(scope, { builtInOlderThan: bundleId }),
    ).toMatchObject({ id: buildId(2) });
    // The usual case reads the newest build alone, and takes it.
    expect(
      await core.findNativeBuild(scope, {
        builtInOlderThan: "01ff0000-0000-7000-8000-000000000000",
      }),
    ).toMatchObject({ id: buildId(4) });
    // No build is older than the oldest.
    expect(
      await core.findNativeBuild(scope, {
        builtInOlderThan: "01000000-0000-7000-8000-000000000000",
      }),
    ).toBeNull();
  });

  it("finds no patch base in a sandbox scope, whose builds the other reads still find", async () => {
    const core = setup();
    const sandbox = await core.registerNativeBuild(sandboxRegistration(1));

    expect(
      await core.findNativeBuild(sandboxScope, {
        builtInOlderThan: "01ff0000-0000-7000-8000-000000000000",
      }),
    ).toBeNull();
    expect(await core.findNativeBuild(sandboxScope)).toEqual(sandbox);
  });
});

describe("sandbox builds on any channel", () => {
  const normalScope = {
    platform: "ios",
    channel: "pr-134",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
  } as const;

  it("registers a sandbox build on a pull request's channel", async () => {
    const core = setup();
    const build = await core.registerNativeBuild(sandboxRegistration(1));
    expect(build).toMatchObject({
      channel_id: `channel:${encodeChannelKey("pr-134")}`,
      is_sandbox: true,
      sandbox_url_scheme: "acme-preview",
      scope_key:
        "v1:sandbox:ios:com.example.app:acme-preview:ipa:direct:fingerprint:fingerprint-a",
    });
    expect(await core.findChannelByName("pr-134")).not.toBeNull();
  });

  it("keeps a normal build and a newer sandbox build of the same fingerprint apart", async () => {
    const core = setup();
    const normal = await core.registerNativeBuild(
      registration(1, { channel: "pr-134" }),
    );
    const sandbox = await core.registerNativeBuild(sandboxRegistration(2));

    expect(await core.findNativeBuild(normalScope)).toEqual(normal);
    expect(
      await core.findNativeBuild(normalScope, {
        builtInOlderThan: "01ff0000-0000-7000-8000-000000000000",
      }),
    ).toEqual(normal);
    expect(await core.findNativeBuild(sandboxScope)).toEqual(sandbox);
  });

  it("finds a sandbox build registered on another pull request's channel", async () => {
    const core = setup();
    const built = await core.registerNativeBuild(
      sandboxRegistration(1, { channel: "pr-120" }),
    );
    // The lookup names pr-140, the channel a build of it would embed.
    expect(await core.findNativeBuild(sandboxScope)).toEqual(built);
    expect(
      await core.findNativeBuild({
        ...sandboxScope,
        fingerprintHash: "fingerprint-b",
      }),
    ).toBeNull();
  });

  it("finds a sandbox build by what installs it: app ID, URL scheme, kind, and distribution", async () => {
    const core = setup();
    const adHoc = await core.registerNativeBuild(sandboxRegistration(1));
    // Newer builds of the same fingerprint that install another way.
    const store = await core.registerNativeBuild(
      sandboxRegistration(2, { exportMethod: "app-store" }),
    );
    await core.registerNativeBuild(
      sandboxRegistration(3, { sandboxAppId: "com.example.other" }),
    );
    await core.registerNativeBuild(
      sandboxRegistration(4, { sandboxUrlScheme: "other-preview" }),
    );
    // An .ipa whose profile wasn't read installs neither way for sure.
    await core.registerNativeBuild(
      sandboxRegistration(5, { exportMethod: null }),
    );

    expect(await core.findNativeBuild(sandboxScope)).toEqual(adHoc);
    expect(
      await core.findNativeBuild({
        ...sandboxScope,
        sandbox: { ...sandboxScope.sandbox, distribution: "store" },
      }),
    ).toEqual(store);
    expect(
      await core.findNativeBuild({
        ...sandboxScope,
        sandbox: { ...sandboxScope.sandbox, appId: "com.example.other" },
      }),
    ).toMatchObject({ id: buildId(3) });
  });

  it("finds no APK sandbox build for an AAB lookup", async () => {
    const core = setup();
    const android = {
      platform: "android",
      sandboxAppId: "com.example.app.sandbox",
      exportMethod: null,
    } as const;
    const apk = await core.registerNativeBuild(
      sandboxRegistration(1, {
        ...android,
        artifact: { kind: "apk", storageUri: "storage://app.apk", byteSize: 1 },
      }),
    );
    const scope = {
      ...sandboxScope,
      platform: "android",
      sandbox: {
        appId: "com.example.app.sandbox",
        urlScheme: "acme-preview",
        artifactKind: "aab",
        distribution: "store",
      },
    } as const;
    expect(await core.findNativeBuild(scope)).toBeNull();
    expect(
      await core.findNativeBuild({
        ...scope,
        sandbox: {
          ...scope.sandbox,
          artifactKind: "apk",
          distribution: "direct",
        },
      }),
    ).toEqual(apk);
  });

  it.each([
    ["an app ID that isn't one", { appId: "com example" }],
    ["an empty app ID", { appId: "" }],
    ["an app ID past 255 characters", { appId: `a${"b".repeat(255)}` }],
    ["a URL scheme in upper case", { urlScheme: "Acme" }],
    ["another platform's kind", { artifactKind: "apk" }],
    ["an unknown distribution", { distribution: "testflight" }],
  ])("refuses a sandbox lookup with %s", async (_, sandbox) => {
    const core = setup();
    await expect(
      core.findNativeBuild({
        ...sandboxScope,
        sandbox: { ...sandboxScope.sandbox, ...sandbox } as never,
      }),
    ).rejects.toThrow(NativeBuildInputError);
  });

  it("tells an older CLI's sandbox registration to upgrade the CLI", async () => {
    const core = setup();
    // What a 1.2 prerelease CLI sent: its reserved channel, no app ID.
    const older = registration(1, {
      channel: "sandbox-release",
      isSandbox: true,
      sandboxUrlScheme: "acme-preview",
      exportMethod: "ad-hoc",
    });
    await expect(core.registerNativeBuild(older)).rejects.toThrow(
      "Upgrade the hot-updater CLI to the version that matches this server, and build again.",
    );
    expect(await core.getNativeBuild(buildId(1))).toBeNull();
  });

  it("refuses a sandbox registration on a channel no release can target", async () => {
    const core = setup();
    await expect(
      core.registerNativeBuild(sandboxRegistration(1, { channel: " pr-1" })),
    ).rejects.toThrow(NativeBuildInputError);
  });
});

describe("a scope's builds of one kind", () => {
  const scope = {
    platform: "ios",
    channel: "production",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
  } as const;
  const app = (n: number, overrides: Partial<NativeBuildRegistration> = {}) =>
    registration(n, {
      artifact: {
        kind: "app",
        storageUri: `storage://native-builds/ios/${buildId(n)}/App.app.zip`,
        byteSize: 1_000 + n,
      },
      ...overrides,
    });

  /**
   * Core over a key-value store, which keeps index copies as it writes rows:
   * the rows `legacy` names get no `byScopeKind` copy, as rows written before
   * the index have none.
   */
  const setupWithLegacy = (legacy: ReadonlySet<string>) => {
    const store = createMemoryKeyValueStore();
    let clock = 1_000;
    return createInProcessCoreApi(
      createKvAdapter({
        store: {
          ...store,
          write: ((ops) =>
            store.write(
              ops.filter(
                (op) =>
                  !(
                    op.type === "put" &&
                    op.key.pk.split("#")[1]?.endsWith("byScopeKind") &&
                    legacy.has(op.value.id as string)
                  ),
              ) as typeof ops,
            )) as typeof store.write,
        },
      }),
      { now: () => (clock += 1) },
    );
  };

  it("finds an .ipa past a newer .app of its scope, which the newest read still answers", async () => {
    const core = setup();
    const ipa = await core.registerNativeBuild(registration(1));
    const simulator = await core.registerNativeBuild(app(2));

    expect(await core.findNativeBuild(scope, { artifactKind: "ipa" })).toEqual(
      ipa,
    );
    expect(await core.findNativeBuild(scope, { artifactKind: "app" })).toEqual(
      simulator,
    );
    expect(await core.findNativeBuild(scope)).toEqual(simulator);
  });

  it("finds an older .app past newer builds of another kind, on a store that reads rows by their fields", async () => {
    const core = setup();
    await core.registerNativeBuild(registration(1));
    const simulator = await core.registerNativeBuild(app(2));
    await core.registerNativeBuild(registration(3));

    expect(await core.findNativeBuild(scope, { artifactKind: "app" })).toEqual(
      simulator,
    );
  });

  it("finds a key-value row written before the kind index only while it is its scope's newest, and never another kind", async () => {
    const core = setupWithLegacy(new Set([buildId(1), buildId(2)]));
    await core.registerNativeBuild(registration(1));
    // A cached Simulator build, which a cache hit reuses and never rewrites.
    const simulator = await core.registerNativeBuild(app(2));

    expect(await core.findNativeBuild(scope, { artifactKind: "app" })).toEqual(
      simulator,
    );
    // The older .ipa is found again once a build of the kind registers.
    expect(
      await core.findNativeBuild(scope, { artifactKind: "ipa" }),
    ).toBeNull();
    const rebuilt = await core.registerNativeBuild(registration(3));
    expect(await core.findNativeBuild(scope, { artifactKind: "ipa" })).toEqual(
      rebuilt,
    );
    // A stated limit: behind the newer .ipa, the legacy .app is no longer
    // found, so it is downloaded again until the native code changes. It
    // is never answered with the .ipa.
    expect(
      await core.findNativeBuild(scope, { artifactKind: "app" }),
    ).toBeNull();
  });

  it("keeps to the kind with a build key or the store mark", async () => {
    const core = setup();
    await core.registerNativeBuild(
      registration(1, { buildKey: `nbk1:${"1".repeat(64)}` }),
    );
    await core.markNativeBuild(buildId(1), { storeBuild: true });

    expect(
      await core.findNativeBuild(scope, {
        buildKey: `nbk1:${"1".repeat(64)}`,
        artifactKind: "app",
      }),
    ).toBeNull();
    expect(
      await core.findNativeBuild(scope, {
        storeBuild: true,
        artifactKind: "app",
      }),
    ).toBeNull();
    expect(
      (
        await core.findNativeBuild(scope, {
          storeBuild: true,
          artifactKind: "ipa",
        })
      )?.id,
    ).toBe(buildId(1));
  });

  it("refuses a kind the platform doesn't build", async () => {
    const core = setup();
    await expect(
      core.findNativeBuild(scope, { artifactKind: "apk" }),
    ).rejects.toThrow(NativeBuildInputError);
  });
});

describe("the other install target of a sandbox build", () => {
  const simulator = (
    n: number,
    overrides: Partial<NativeBuildRegistration> = {},
  ) =>
    sandboxRegistration(n, {
      channel: "pr-140",
      exportMethod: null,
      artifact: {
        kind: "app",
        storageUri: `storage://native-builds/ios/${buildId(n)}/App.app.zip`,
        byteSize: 1_000 + n,
      },
      ...overrides,
    });

  it("pairs an ad hoc .ipa and a Simulator .app of the same app and fingerprint, on any channel", async () => {
    const core = setup();
    const ipa = await core.registerNativeBuild(sandboxRegistration(1));
    const app = await core.registerNativeBuild(simulator(2));

    expect(await core.findNativeBuildSibling(ipa)).toEqual(app);
    expect(await core.findNativeBuildSibling(app)).toEqual(ipa);
  });

  it("pairs builds of the app-version strategy by their exact app version", async () => {
    const core = setup();
    const target = { fingerprintHash: null, appVersion: "1.4.0" } as const;
    const ipa = await core.registerNativeBuild(sandboxRegistration(1, target));
    const app = await core.registerNativeBuild(simulator(2, target));
    await core.registerNativeBuild(
      simulator(3, { fingerprintHash: null, appVersion: "1.5.0" }),
    );

    expect(await core.findNativeBuildSibling(ipa)).toEqual(app);
  });

  it("answers the newest, so an .ipa rebuilt for a new iPhone wins", async () => {
    const core = setup();
    await core.registerNativeBuild(sandboxRegistration(1));
    const app = await core.registerNativeBuild(simulator(2));
    const rebuilt = await core.registerNativeBuild(sandboxRegistration(3));

    expect(await core.findNativeBuildSibling(app)).toEqual(rebuilt);
  });

  it("pairs nothing of another fingerprint or app", async () => {
    const core = setup();
    const ipa = await core.registerNativeBuild(sandboxRegistration(1));
    await core.registerNativeBuild(
      simulator(2, { fingerprintHash: "fingerprint-b" }),
    );
    await core.registerNativeBuild(
      simulator(3, {
        sandboxAppId: "com.example.other",
        sandboxUrlScheme: "other-preview",
      }),
    );

    expect(await core.findNativeBuildSibling(ipa)).toBeNull();
  });

  it("pairs no normal build, which records no app", async () => {
    const core = setup();
    const ipa = await core.registerNativeBuild(registration(1));
    const app = await core.registerNativeBuild(
      registration(2, {
        artifact: {
          kind: "app",
          storageUri: "storage://native-builds/ios/2/App.app.zip",
          byteSize: 2,
        },
      }),
    );

    expect(await core.findNativeBuildSibling(ipa)).toBeNull();
    expect(await core.findNativeBuildSibling(app)).toBeNull();
  });

  it("pairs neither way with a store-marked ad hoc .ipa", async () => {
    const { core, db } = setupWithDb();
    await core.registerNativeBuild(sandboxRegistration(1));
    const app = await core.registerNativeBuild(simulator(2));
    await setRow(db, buildId(1), { is_store_build: true });
    const marked = (await core.getNativeBuild(buildId(1)))!;

    expect(marked.is_store_build).toBe(true);
    expect(await core.findNativeBuildSibling(app)).toBeNull();
    expect(await core.findNativeBuildSibling(marked)).toBeNull();
  });

  it("pairs neither way with an .ipa a store took, or one exported for the App Store", async () => {
    const core = setup();
    await core.registerNativeBuild(sandboxRegistration(1));
    const app = await core.registerNativeBuild(simulator(2));
    const submitted = await core.recordNativeBuildSubmission(buildId(1), {
      destination: "testflight",
      version: "1.0 (1)",
    });
    const store = await core.registerNativeBuild(
      sandboxRegistration(3, { exportMethod: "app-store" }),
    );

    expect(await core.findNativeBuildSibling(app)).toBeNull();
    expect(await core.findNativeBuildSibling(submitted!)).toBeNull();
    expect(await core.findNativeBuildSibling(store)).toBeNull();
  });

  it("pairs no Android build", async () => {
    const core = setup();
    const apk = await core.registerNativeBuild(
      sandboxRegistration(1, {
        platform: "android",
        exportMethod: null,
        artifact: {
          kind: "apk",
          storageUri: "storage://native-builds/android/1/app.apk",
          byteSize: 1,
        },
      }),
    );

    expect(await core.findNativeBuildSibling(apk)).toBeNull();
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
