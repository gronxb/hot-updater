import {
  createReleaseCatalogScopeKey,
  createReleaseSelectionContextHash,
  encodeChannelKey,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
} from "@hot-updater/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HotUpdater } from "./index";
import type {
  AcceptCatalogParams,
  HotUpdaterLynxNative,
  NativeState,
  PrepareSelectionParams,
} from "./types";

const id = (value: number) =>
  `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const A = id(1);
const B = id(2);
const C = id(3);
const releaseA = id(11);
const releaseB = id(12);
const releaseC = id(13);
const scopeKey = createReleaseCatalogScopeKey({
  strategy: "APP_VERSION",
  platform: "android",
  channelKey: encodeChannelKey("production"),
});
const catalogHash = `sha256:${"a".repeat(64)}`;

const release = (
  releaseId: string,
  bundleId: string | null,
): ReleaseCatalogDescriptor => ({
  releaseId,
  bundleId,
  kind: bundleId === null ? "EMBEDDED" : "BUNDLE",
  rolloutCohortCount: 1000,
  targetCohorts: [],
  shouldForceUpdate: false,
  message: null,
});

function receipt(
  bundleId = A,
  releaseId: string | null = null,
): PersistedSelectionReceipt {
  return {
    kind: releaseId === null ? "BUILTIN" : "BUNDLE",
    bundleId,
    releaseId,
    catalogId: releaseId === null ? null : "catalog",
    scopeKey: releaseId === null ? null : scopeKey,
    generation: releaseId === null ? null : 1,
    catalogHash: releaseId === null ? null : catalogHash,
    channel: "production",
    selectionContextHash: releaseId === null ? null : "previous-context",
  };
}

function setup(
  overrides: Partial<NativeState> = {},
  releases = [release(releaseB, B)],
) {
  const state: NativeState = {
    revision: "native-revision-1",
    platform: "android",
    appVersion: "1.0.0",
    channel: "production",
    channelKey: "cHJvZHVjdGlvbg",
    runtimeId: "native-runtime",
    embeddedBundleId: A,
    minimumBundleId: A,
    cohort: "1",
    runningSelection: receipt(),
    runningConfirmed: true,
    confirmedSelection: null,
    nextSelection: null,
    crashedBundleIds: [],
    unconfirmedReleaseIds: [],
    ...overrides,
  };
  const catalog: ReleaseCatalog = {
    schemaVersion: 1,
    catalogId: "catalog",
    scopeKey,
    generation: 2,
    catalogHash,
    fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
    releases,
  };
  const native = {
    getState: vi.fn<HotUpdaterLynxNative["getState"]>((callback) =>
      callback({ ok: true, data: state }),
    ),
    acceptCatalog: vi.fn<HotUpdaterLynxNative["acceptCatalog"]>(
      (params, callback) =>
        callback({
          ok: true,
          data: {
            revision: "accepted-revision",
            catalogId: params.catalog.catalogId,
            scopeKey: params.catalog.scopeKey,
            generation: params.catalog.generation,
            catalogHash: params.catalog.catalogHash,
            channel: state.channel,
            selectionContextHash: params.selectionContextHash,
          },
        }),
    ),
    prepareSelection: vi.fn<HotUpdaterLynxNative["prepareSelection"]>(
      (_params, callback) =>
        callback({ ok: true, data: { preparedId: "native-prepared" } }),
    ),
    stageSelection: vi.fn<HotUpdaterLynxNative["stageSelection"]>(
      (_params, callback) =>
        callback({
          ok: true,
          data: { status: "STAGED", requiresRestart: true },
        }),
    ),
    notifyAppReady: vi.fn<HotUpdaterLynxNative["notifyAppReady"]>(),
    setChannel: vi.fn<NonNullable<HotUpdaterLynxNative["setChannel"]>>(
      (params, callback) => {
        state.channel = params.channel;
        state.channelKey = encodeChannelKey(params.channel);
        callback({ ok: true, data: { ...state } });
      },
    ),
  };
  vi.stubGlobal("NativeModules", { HotUpdaterLynx: native });
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/release-catalogs/")
            ? catalog
            : {
                fileUrl: "/storage/archive.tar.gz",
                fileHash: "b".repeat(64),
              },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  HotUpdater.init({ baseURL: "https://updates.test" });
  const prepared = () =>
    native.prepareSelection.mock.calls[0]![0] as PrepareSelectionParams;
  return { updater: HotUpdater, state, catalog, native, fetch, prepared };
}

afterEach(() => vi.unstubAllGlobals());

describe("Lynx catalog controller (mock native transport)", () => {
  it("prepares during check but publishes only the retained native token on install", async () => {
    const { updater, native, prepared } = setup();
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    expect(prepared().artifact).toEqual({
      bundleId: B,
      fileUrl: "https://updates.test/storage/archive.tar.gz",
      fileHash: "b".repeat(64),
      manifestFileHash: null,
    });
    expect(prepared().selection.bundleId).toBe(B);
    expect(native.stageSelection).not.toHaveBeenCalled();
    expect((await updater.getLaunchInfo()).running.bundleId).toBe(A);
    const first = update!.updateBundle();
    const second = update!.updateBundle();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(native.stageSelection).toHaveBeenCalledOnce();
    expect(native.stageSelection.mock.calls[0]![0]).toEqual({
      preparedId: "native-prepared",
    });
  });

  it("uses the native guard selection context hash on the prepared receipt", async () => {
    const { updater, native, prepared } = setup();
    native.acceptCatalog.mockImplementation((params, callback) =>
      callback({
        ok: true,
        data: {
          revision: "accepted-revision",
          catalogId: params.catalog.catalogId,
          scopeKey: params.catalog.scopeKey,
          generation: params.catalog.generation,
          catalogHash: params.catalog.catalogHash,
          channel: "production",
          selectionContextHash: "v1:nativeguardhash",
        },
      }),
    );
    await updater.checkForUpdate({ updateStrategy: "appVersion" });
    expect(prepared().selection.selectionContextHash).toBe(
      "v1:nativeguardhash",
    );
    expect(prepared().guard.selectionContextHash).toBe("v1:nativeguardhash");
  });

  it("preserves every unconfirmed exclusion in selection and its context while allowing a new Release for the same bytes", async () => {
    const newRelease = id(14);
    const { updater, native, prepared, state } = setup(
      {
        runningSelection: receipt(A, releaseA),
        unconfirmedReleaseIds: [releaseB, releaseC],
      },
      [
        release(releaseC, C),
        release(releaseB, B),
        release(newRelease, B),
        release(releaseA, A),
      ],
    );
    // Catalog order is policy order: exclusions apply even ahead of a valid target.
    expect(
      (await updater.checkForUpdate({ updateStrategy: "appVersion" }))
        ?.releaseId,
    ).toBe(newRelease);
    expect(prepared().selection.releaseId).toBe(newRelease);
    const accepted = native.acceptCatalog.mock
      .calls[0]![0] as AcceptCatalogParams;
    expect(accepted.expectedRevision).toBe(state.revision);
    expect(accepted.selectionContextHash).toBe(
      createReleaseSelectionContextHash({
        activeBundleId: A,
        activeReleaseId: releaseA,
        cohort: "1",
        minimumReleaseId: A,
        strategy: "APP_VERSION",
        strategyValue: "1.0.0",
        crashedBundleIds: [],
        unconfirmedReleaseIds: [releaseB, releaseC],
      }),
    );
  });

  it("ignores leftover next selection after an explicit channel switch", async () => {
    const { updater, native, prepared, fetch } = setup({
      runningSelection: receipt(),
      nextSelection: receipt(B, releaseB),
    });
    const betaScope = createReleaseCatalogScopeKey({
      strategy: "APP_VERSION",
      platform: "android",
      channelKey: encodeChannelKey("beta"),
    });
    native.acceptCatalog.mockImplementation((params, callback) =>
      callback({
        ok: true,
        data: {
          revision: "accepted-revision",
          catalogId: params.catalog.catalogId,
          scopeKey: params.catalog.scopeKey,
          generation: params.catalog.generation,
          catalogHash: params.catalog.catalogHash,
          channel: "beta",
          selectionContextHash: params.selectionContextHash,
        },
      }),
    );
    fetch.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("/release-catalogs/")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            catalogId: "catalog",
            scopeKey: betaScope,
            generation: 2,
            catalogHash,
            fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
            releases: [release(releaseC, C)],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          fileUrl: "/storage/archive.tar.gz",
          fileHash: "b".repeat(64),
        }),
        { status: 200 },
      );
    });
    await updater.checkForUpdate({
      updateStrategy: "appVersion",
      channel: "beta",
    });
    expect(native.setChannel).toHaveBeenCalledOnce();
    expect(prepared().selection.bundleId).toBe(C);
    expect(prepared().selection.channel).toBe("beta");
  });

  it("uses a staged selection for policy while resolving artifacts from actual running bytes", async () => {
    const { updater, fetch, prepared } = setup(
      {
        runningSelection: receipt(A, releaseA),
        nextSelection: receipt(B, releaseB),
      },
      [release(releaseC, C), release(releaseB, B)],
    );
    await updater.checkForUpdate({ updateStrategy: "appVersion" });
    expect(prepared().selection.bundleId).toBe(C);
    expect(fetch.mock.calls[1]![0]).toBe(
      `https://updates.test/artifacts/${C}/from/${A}`,
    );
    expect((await updater.getLaunchInfo()).next?.bundleId).toBe(B);
  });

  it("does not assume matching unconfirmed running bytes are eligible for metadata adoption", async () => {
    const { updater, fetch, prepared } = setup(
      { runningSelection: receipt(B, releaseB), runningConfirmed: false },
      [release(id(14), B)],
    );
    await updater.checkForUpdate({ updateStrategy: "appVersion" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(prepared().artifact?.bundleId).toBe(B);
    expect(prepared()).not.toHaveProperty("alreadyConfirmed");
  });

  it("lets native decide metadata adoption for newly authorized confirmed running bytes", async () => {
    const { updater, native, fetch, prepared } = setup(
      { runningSelection: receipt(B, releaseB), runningConfirmed: true },
      [release(id(14), B)],
    );
    native.stageSelection.mockImplementation((_params, callback) =>
      callback({
        ok: true,
        data: { status: "ADOPTED", requiresRestart: false },
      }),
    );
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    expect(prepared().artifact).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(native.stageSelection).not.toHaveBeenCalled();
    await expect(update!.updateBundle()).resolves.toBe(true);
  });

  it("stages an authorized builtin rollback without a Release id or archive", async () => {
    const { updater, fetch, prepared } = setup(
      { runningSelection: receipt(B, releaseB) },
      [],
    );
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    expect(update).toMatchObject({
      bundleId: A,
      releaseId: null,
      status: "ROLLBACK",
      transitionKind: "USE_BUILTIN",
    });
    expect(prepared()).toMatchObject({
      artifact: null,
      selection: { kind: "BUILTIN", bundleId: A, releaseId: null },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stages an authorized embedded rollback without requesting an archive", async () => {
    const { updater, fetch, prepared } = setup(
      { runningSelection: receipt(B, releaseB) },
      [release(id(14), null)],
    );
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    expect(update).toMatchObject({ bundleId: A, status: "ROLLBACK" });
    expect(prepared()).toMatchObject({
      artifact: null,
      selection: { kind: "EMBEDDED", bundleId: A },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("honors exclusions while choosing a predecessor rollback", async () => {
    const { updater, catalog, prepared } = setup(
      {
        runningSelection: receipt(C, releaseC),
        unconfirmedReleaseIds: [releaseB, releaseC],
      },
      [],
    );
    Object.assign(catalog, {
      rollbackReleases: [
        release(releaseC, C),
        release(releaseB, B),
        release(releaseA, A),
      ],
    });
    expect(
      await updater.checkForUpdate({ updateStrategy: "appVersion" }),
    ).toMatchObject({
      releaseId: releaseA,
      status: "ROLLBACK",
    });
    expect(prepared().selection.releaseId).toBe(releaseA);
  });

  it("propagates native snapshot rejection before preparation", async () => {
    const { updater, native, fetch } = setup();
    native.acceptCatalog.mockImplementation((_params, callback) =>
      callback({
        ok: false,
        error: { code: "STALE_SELECTION", message: "Native state changed." },
      }),
    );
    await expect(
      updater.checkForUpdate({ updateStrategy: "appVersion" }),
    ).rejects.toMatchObject({
      code: "STALE_SELECTION",
    });
    expect(native.prepareSelection).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects INCOMPATIBLE during check instead of returning an installable update", async () => {
    const { updater, native } = setup();
    native.prepareSelection.mockImplementation((_params, callback) =>
      callback({
        ok: false,
        error: {
          code: "INCOMPATIBLE",
          message: "The verified runtime identity differs.",
        },
      }),
    );
    await expect(
      updater.checkForUpdate({ updateStrategy: "appVersion" }),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE",
    });
    expect(native.stageSelection).not.toHaveBeenCalled();
  });

  it("does not return an installable update without a native prepared token", async () => {
    const { updater, native } = setup();
    native.prepareSelection.mockImplementation((_params, callback) =>
      callback({ ok: true, data: { preparedId: "" } }),
    );
    await expect(
      updater.checkForUpdate({ updateStrategy: "appVersion" }),
    ).rejects.toMatchObject({
      code: "INVALID_NATIVE_REPLY",
    });
    expect(native.stageSelection).not.toHaveBeenCalled();
  });

  it("rejects stale prepared installation without fetching or selecting a new candidate", async () => {
    const { updater, native, fetch } = setup();
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    native.stageSelection.mockImplementation((_params, callback) =>
      callback({
        ok: false,
        error: {
          code: "STALE_SELECTION",
          message: "Exclusions changed after preparation.",
        },
      }),
    );
    await expect(update!.updateBundle()).rejects.toMatchObject({
      code: "STALE_SELECTION",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(native.prepareSelection).toHaveBeenCalledOnce();
  });

  it("still accepts catalog high-water when already on the built-in selection", async () => {
    const { updater, native, fetch } = setup({}, []);
    await expect(
      updater.checkForUpdate({ updateStrategy: "appVersion" }),
    ).resolves.toBeNull();
    expect(native.acceptCatalog).toHaveBeenCalledOnce();
    expect(native.prepareSelection).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stages builtin fallback when overlay is running over a confirmed bundle", async () => {
    const { updater, prepared } = setup(
      { confirmedSelection: receipt(B, releaseB) },
      [],
    );
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    expect(update).toMatchObject({
      status: "ROLLBACK",
      transitionKind: "USE_BUILTIN",
    });
    expect(prepared()).toMatchObject({
      artifact: null,
      selection: { kind: "BUILTIN", bundleId: A, releaseId: null },
    });
  });

  it("stages builtin fallback when overlay is running over a staged next bundle", async () => {
    const { updater, prepared } = setup(
      {
        runningSelection: receipt(),
        nextSelection: receipt(B, releaseB),
        confirmedSelection: null,
      },
      [],
    );
    const update = await updater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    expect(update).toMatchObject({
      status: "ROLLBACK",
      transitionKind: "USE_BUILTIN",
    });
    expect(prepared()).toMatchObject({
      artifact: null,
      selection: { kind: "BUILTIN", bundleId: A, releaseId: null },
    });
  });
});
