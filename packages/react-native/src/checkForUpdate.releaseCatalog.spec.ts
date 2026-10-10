import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type ArtifactInfo,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LaunchReporter } from "./appReady";
import type { HotUpdaterClientHooks } from "./clientPlugin";
import type { HotUpdaterHttpClient } from "./httpClient";
import { InvalidUpdateResponseError, UpdateHttpError } from "./updateError";

const MINIMUM_RELEASE_ID = "00000000-0000-7000-8000-000000000001";
const RELEASE_ID = "00000000-0000-7000-8000-000000000002";
const ACTIVE_RELEASE_ID = "00000000-0000-7000-8000-000000000003";
const CURRENT_BUNDLE_ID = "00000000-0000-7001-8000-000000000001";
const TARGET_BUNDLE_ID = "00000000-0000-7001-8000-000000000002";
const CATALOG_ID = "project-a";
const CHANNEL = "production";
const CATALOG_HASH = `sha256:${"a".repeat(64)}`;
const SCOPE_KEY = createReleaseCatalogScopeKey({
  channelKey: encodeChannelKey(CHANNEL),
  platform: "ios",
  strategy: "APP_VERSION",
});

const mocks = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", { SDK_VERSION: "test-sdk-version" });
  return {
    addListener: vi.fn(() => () => {}),
    acceptReleaseCatalog: vi.fn(() => true),
    commitReleaseSelection: vi.fn(async () => true),
    getActiveUpdateState: vi.fn(() => ({
      activeSelection: null as PersistedSelectionReceipt | null,
      highestSeenCatalogs: {},
      stableSelection: null as PersistedSelectionReceipt | null,
      verificationPending: false,
    })),
    getAppVersion: vi.fn(() => "1.2"),
    getBundleId: vi.fn(() => CURRENT_BUNDLE_ID),
    getChannel: vi.fn(() => CHANNEL),
    getCohort: vi.fn(() => "123"),
    getCrashHistory: vi.fn(() => []),
    getDefaultChannel: vi.fn(() => CHANNEL),
    getFingerprintHash: vi.fn(() => null),
    getInstallId: vi.fn(() => "install-id"),
    getMinBundleId: vi.fn(() => MINIMUM_RELEASE_ID),
    isChannelSwitched: vi.fn(() => false),
    isReleaseSelectionCurrent: vi.fn(() => true),
    resetChannel: vi.fn(),
    stageBundle: vi.fn(
      async (): Promise<{
        delivery: "patch" | "manifest" | "archive";
        patchFallback: boolean;
      } | null> => ({ delivery: "manifest", patchFallback: false }),
    ),
  };
});

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("./native", () => mocks);

const createCatalog = (
  overrides: Partial<ReleaseCatalog> = {},
): ReleaseCatalog => {
  const releases = overrides.releases ?? [
    {
      bundleId: TARGET_BUNDLE_ID,
      kind: "BUNDLE",
      message: "Release two",
      releaseId: RELEASE_ID,
      rolloutCohortCount: 1000,
      shouldForceUpdate: false,
      targetCohorts: [],
    },
  ];
  return {
    catalogId: CATALOG_ID,
    catalogHash: CATALOG_HASH,
    fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
    generation: 2,
    releases,
    rollbackReleases: releases,
    schemaVersion: 1,
    scopeKey: SCOPE_KEY,
    ...overrides,
  };
};

const createClient = (catalog = createCatalog()) => {
  const fetchReleaseCatalog = vi.fn(async () => catalog);
  const artifact: ArtifactInfo = {
    artifactProtocolVersion: 1,
    assets: {},
    manifestFileHash: "manifest-hash",
    manifestUrl: "https://updates.example.com/manifest.json",
    archiveUrl: "https://updates.example.com/bundle.tar.br",
  };
  const resolveArtifact = vi.fn(async () => artifact);
  const session = {
    fetchReleaseCatalog,
    resolveArtifact,
  };
  const client: HotUpdaterHttpClient = {
    createSession: vi.fn(async () => session),
  };
  return { client, fetchReleaseCatalog, resolveArtifact };
};

type PluginEvent = {
  [K in keyof HotUpdaterClientHooks]-?: [
    K,
    Parameters<NonNullable<HotUpdaterClientHooks[K]>>[0],
  ];
}[keyof HotUpdaterClientHooks];

/** The checking instance's plugin hooks; a test that records them sets it. */
let emit: LaunchReporter["emit"] = () => {};

/** Records what checks report to plugins, in order. */
const recordPluginEvents = async () => {
  const { createAppPluginHost } = await import("./pluginHost");
  const { createLaunchReporter } = await import("./appReady");
  const host = createAppPluginHost();
  emit = createLaunchReporter(host).emit;
  const events: PluginEvent[] = [];
  host.configurePlugins(
    [
      {
        id: "recorder",
        setup: () => ({
          hooks: {
            onUpdateCheck: (result) => {
              events.push(["onUpdateCheck", result]);
            },
            onBundleDownloaded: (info) => {
              events.push(["onBundleDownloaded", info]);
            },
            onUpdateError: (error) => {
              events.push(["onUpdateError", error]);
            },
          },
        }),
      },
    ],
    { baseURL: "https://updates.example.com" },
  );
  return events;
};

describe("checkForUpdate Release catalog protocol", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    emit = () => {};
    vi.stubGlobal("__DEV__", false);
    mocks.acceptReleaseCatalog.mockReturnValue(true);
    mocks.getActiveUpdateState.mockReturnValue({
      activeSelection: null,
      highestSeenCatalogs: {},
      stableSelection: null,
      verificationPending: false,
    });
    mocks.isReleaseSelectionCurrent.mockReturnValue(true);
    mocks.commitReleaseSelection.mockResolvedValue(true);
    mocks.stageBundle.mockResolvedValue({
      delivery: "manifest",
      patchFallback: false,
    });
  });

  it("reports the check, then the download only after staging", async () => {
    const { checkForUpdate } = await import("./checkForUpdate");
    const events = await recordPluginEvents();
    const { client } = createClient();
    let complete!: (delivery: {
      delivery: "patch" | "manifest" | "archive";
      patchFallback: boolean;
    }) => void;
    mocks.stageBundle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const update = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });
    expect(update?.shouldForceUpdate).toBe(false);
    expect(events).toEqual([
      [
        "onUpdateCheck",
        {
          status: "UPDATE_AVAILABLE",
          channel: CHANNEL,
          fromBundleId: CURRENT_BUNDLE_ID,
          fromReleaseId: null,
          toBundleId: TARGET_BUNDLE_ID,
          toReleaseId: RELEASE_ID,
          transitionKind: "INSTALL",
          updateStatus: "UPDATE",
          shouldForceUpdate: false,
          updateStrategy: "appVersion",
        },
      ],
    ]);
    const pending = update!.updateBundle();
    await vi.waitFor(() => expect(mocks.stageBundle).toHaveBeenCalledOnce());
    expect(events).toHaveLength(1);
    complete({ delivery: "patch", patchFallback: true });
    await expect(pending).resolves.toBe(true);
    expect(events[1]).toEqual([
      "onBundleDownloaded",
      {
        channel: CHANNEL,
        fromBundleId: CURRENT_BUNDLE_ID,
        fromReleaseId: null,
        toBundleId: TARGET_BUNDLE_ID,
        toReleaseId: RELEASE_ID,
        updateStrategy: "appVersion",
        delivery: "patch",
        patchFallback: true,
      },
    ]);
  });

  it.each(["nothing new", "failure"])(
    "does not report a download when staging brings %s",
    async (result) => {
      const { checkForUpdate } = await import("./checkForUpdate");
      const events = await recordPluginEvents();
      const { client } = createClient();
      if (result === "nothing new")
        mocks.stageBundle.mockResolvedValueOnce(null);
      else
        mocks.stageBundle.mockRejectedValueOnce(new Error("download failed"));
      const update = await checkForUpdate({
        emit,
        client,
        updateStrategy: "appVersion",
      });
      await update!.updateBundle().catch(() => false);
      expect(events.map(([name]) => name)).not.toContain("onBundleDownloaded");
    },
  );

  it("selects locally and defers Bundle artifact resolution until install", async () => {
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client, fetchReleaseCatalog, resolveArtifact } = createClient();

    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: RELEASE_ID,
      releaseId: RELEASE_ID,
      transitionKind: "INSTALL",
    });
    expect(fetchReleaseCatalog).toHaveBeenCalledWith({
      appVersion: "1.2.0",
      channel: CHANNEL,
      fingerprintHash: null,
      platform: "ios",
      requestHeaders: undefined,
      requestTimeout: undefined,
      updateStrategy: "appVersion",
    });
    expect(resolveArtifact).not.toHaveBeenCalled();

    await expect(result?.updateBundle()).resolves.toBe(true);

    expect(resolveArtifact).toHaveBeenCalledWith({
      currentBundleId: CURRENT_BUNDLE_ID,
      requestHeaders: undefined,
      requestTimeout: undefined,
      targetBundleId: TARGET_BUNDLE_ID,
    });
    expect(mocks.stageBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
        archiveUrl: "https://updates.example.com/bundle.tar.br",
        selection: expect.objectContaining({
          catalogId: CATALOG_ID,
          releaseId: RELEASE_ID,
          scopeKey: SCOPE_KEY,
        }),
      }),
    );
  });

  it("adopts a newer Release for the same Bundle without resolving bytes", async () => {
    const active: PersistedSelectionReceipt = {
      catalogId: CATALOG_ID,
      bundleId: TARGET_BUNDLE_ID,
      catalogHash: `sha256:${"b".repeat(64)}`,
      channel: CHANNEL,
      generation: 1,
      kind: "BUNDLE",
      releaseId: MINIMUM_RELEASE_ID,
      scopeKey: SCOPE_KEY,
      selectionContextHash: "old-context",
    };
    mocks.getBundleId.mockReturnValueOnce(TARGET_BUNDLE_ID);
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const { checkForUpdate } = await import("./checkForUpdate");
    const forceCatalog = createCatalog({
      releases: [
        {
          ...createCatalog().releases[0]!,
          shouldForceUpdate: true,
        },
      ],
    });
    const events = await recordPluginEvents();
    const { client, resolveArtifact } = createClient(forceCatalog);

    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: RELEASE_ID,
      shouldForceUpdate: false,
      transitionKind: "ADOPT_RELEASE",
    });
    await expect(result?.updateBundle()).resolves.toBe(true);
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(mocks.stageBundle).not.toHaveBeenCalled();
    expect(events.map(([name]) => name)).not.toContain("onBundleDownloaded");
    expect(mocks.commitReleaseSelection).toHaveBeenCalledWith({
      guard: expect.objectContaining({ generation: 2, scopeKey: SCOPE_KEY }),
      selection: expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
        releaseId: RELEASE_ID,
      }),
    });
  });

  it("reports a same-file adoption as UNCHANGED with the adopted Release", async () => {
    const active: PersistedSelectionReceipt = {
      catalogId: CATALOG_ID,
      bundleId: TARGET_BUNDLE_ID,
      catalogHash: `sha256:${"b".repeat(64)}`,
      channel: CHANNEL,
      generation: 1,
      kind: "BUNDLE",
      releaseId: MINIMUM_RELEASE_ID,
      scopeKey: SCOPE_KEY,
      selectionContextHash: "old-context",
    };
    mocks.getBundleId.mockReturnValueOnce(TARGET_BUNDLE_ID);
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const { checkForUpdate } = await import("./checkForUpdate");
    const events = await recordPluginEvents();
    const { client } = createClient();

    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });
    await result?.updateBundle();

    expect(events.at(-1)).toEqual([
      "onUpdateCheck",
      {
        status: "UNCHANGED",
        channel: CHANNEL,
        bundleId: TARGET_BUNDLE_ID,
        releaseId: RELEASE_ID,
        previousReleaseId: MINIMUM_RELEASE_ID,
      },
    ]);
  });

  it("selects a lower-id Release when explicitly switching scopes", async () => {
    const betaChannel = "beta";
    const betaScopeKey = createReleaseCatalogScopeKey({
      channelKey: encodeChannelKey(betaChannel),
      platform: "ios",
      strategy: "APP_VERSION",
    });
    const active: PersistedSelectionReceipt = {
      catalogId: CATALOG_ID,
      bundleId: CURRENT_BUNDLE_ID,
      catalogHash: `sha256:${"b".repeat(64)}`,
      channel: CHANNEL,
      generation: 1,
      kind: "BUNDLE",
      releaseId: ACTIVE_RELEASE_ID,
      scopeKey: SCOPE_KEY,
      selectionContextHash: "old-context",
    };
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const betaCatalog = createCatalog({ scopeKey: betaScopeKey });
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient(betaCatalog);

    const result = await checkForUpdate({
      emit,
      channel: betaChannel,
      client,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: RELEASE_ID,
      releaseId: RELEASE_ID,
      status: "UPDATE",
      transitionKind: "INSTALL",
    });
  });

  it("refreshes the same Release receipt when catalog provenance changes", async () => {
    const active: PersistedSelectionReceipt = {
      catalogId: CATALOG_ID,
      bundleId: TARGET_BUNDLE_ID,
      catalogHash: `sha256:${"b".repeat(64)}`,
      channel: CHANNEL,
      generation: 1,
      kind: "BUNDLE",
      releaseId: RELEASE_ID,
      scopeKey: SCOPE_KEY,
      selectionContextHash: "old-context",
    };
    mocks.getBundleId.mockReturnValueOnce(TARGET_BUNDLE_ID);
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client, resolveArtifact } = createClient();

    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: RELEASE_ID,
      releaseId: RELEASE_ID,
      transitionKind: "ADOPT_RELEASE",
    });
    await expect(result?.updateBundle()).resolves.toBe(true);
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(mocks.stageBundle).not.toHaveBeenCalled();
    expect(mocks.commitReleaseSelection).toHaveBeenCalledWith({
      guard: expect.objectContaining({
        catalogHash: CATALOG_HASH,
        generation: 2,
        scopeKey: SCOPE_KEY,
      }),
      selection: expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
        catalogHash: CATALOG_HASH,
        generation: 2,
        releaseId: RELEASE_ID,
      }),
    });
  });

  it("rejects a slow artifact completion after a newer catalog wins", async () => {
    mocks.isReleaseSelectionCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const { StaleReleaseCatalogError } = await import("./error");
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient();
    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });

    await expect(result?.updateBundle()).rejects.toBeInstanceOf(
      StaleReleaseCatalogError,
    );
    expect(mocks.stageBundle).not.toHaveBeenCalled();
  });

  it("installs an older enabled Release as a forced rollback", async () => {
    const active: PersistedSelectionReceipt = {
      catalogId: CATALOG_ID,
      bundleId: CURRENT_BUNDLE_ID,
      catalogHash: `sha256:${"b".repeat(64)}`,
      channel: CHANNEL,
      generation: 1,
      kind: "BUNDLE",
      releaseId: ACTIVE_RELEASE_ID,
      scopeKey: SCOPE_KEY,
      selectionContextHash: "old-context",
    };
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const catalog = createCatalog({
      rollbackReleases: [
        {
          bundleId: TARGET_BUNDLE_ID,
          kind: "BUNDLE",
          message: "Previous Release",
          releaseId: RELEASE_ID,
          rolloutCohortCount: 0,
          shouldForceUpdate: false,
          targetCohorts: [],
        },
      ],
    });
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient(catalog);

    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: RELEASE_ID,
      releaseId: RELEASE_ID,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      transitionKind: "INSTALL",
    });
    await expect(result?.updateBundle()).resolves.toBe(true);
    expect(mocks.stageBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
        status: "ROLLBACK",
      }),
    );
  });

  it("uses current Bundle identity when migrating an unauthenticated receipt", async () => {
    const migratedCurrentBundleId = "00000000-0000-7001-8000-000000000003";
    const active: PersistedSelectionReceipt = {
      catalogId: null,
      bundleId: migratedCurrentBundleId,
      catalogHash: null,
      channel: CHANNEL,
      generation: null,
      kind: "BUNDLE",
      releaseId: null,
      scopeKey: null,
      selectionContextHash: null,
    };
    mocks.getBundleId.mockReturnValueOnce(migratedCurrentBundleId);
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const catalog = createCatalog({
      releases: [],
      rollbackReleases: [
        {
          ...createCatalog().releases[0]!,
          rolloutCohortCount: 0,
        },
      ],
    });
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient(catalog);

    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: RELEASE_ID,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      transitionKind: "INSTALL",
    });
  });

  it.each(["EMBEDDED", "BUILTIN"] as const)(
    "returns a forced %s rollback with its console ID or built-in fallback",
    async (kind) => {
      const active: PersistedSelectionReceipt = {
        catalogId: CATALOG_ID,
        bundleId: CURRENT_BUNDLE_ID,
        catalogHash: `sha256:${"b".repeat(64)}`,
        channel: CHANNEL,
        generation: 1,
        kind: "BUNDLE",
        releaseId: MINIMUM_RELEASE_ID,
        scopeKey: SCOPE_KEY,
        selectionContextHash: "old-context",
      };
      mocks.getActiveUpdateState.mockReturnValueOnce({
        activeSelection: active,
        highestSeenCatalogs: {},
        stableSelection: active,
        verificationPending: false,
      });
      const { checkForUpdate } = await import("./checkForUpdate");
      const { client, resolveArtifact } = createClient(
        createCatalog({
          releases:
            kind === "EMBEDDED"
              ? [{ ...createCatalog().releases[0]!, kind, bundleId: null }]
              : [],
          rollbackReleases: [],
        }),
      );

      const result = await checkForUpdate({
        emit,
        client,
        updateStrategy: "appVersion",
      });

      expect(result).toMatchObject({
        id: kind === "EMBEDDED" ? RELEASE_ID : MINIMUM_RELEASE_ID,
        releaseId: kind === "EMBEDDED" ? RELEASE_ID : null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
        transitionKind: kind === "EMBEDDED" ? "USE_EMBEDDED" : "USE_BUILTIN",
      });
      await expect(result?.updateBundle()).resolves.toBe(true);
      expect(mocks.commitReleaseSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: expect.objectContaining({
            bundleId: MINIMUM_RELEASE_ID,
            kind,
            releaseId: kind === "EMBEDDED" ? RELEASE_ID : null,
          }),
        }),
      );
      expect(resolveArtifact).not.toHaveBeenCalled();
      expect(mocks.stageBundle).not.toHaveBeenCalled();
    },
  );

  it("does not surface a rollback when the app already uses built-in bytes", async () => {
    mocks.getBundleId.mockReturnValueOnce(MINIMUM_RELEASE_ID);
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient(
      createCatalog({ releases: [], rollbackReleases: [] }),
    );

    await expect(
      checkForUpdate({ emit, client, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();
    expect(mocks.commitReleaseSelection).not.toHaveBeenCalled();
  });

  it("reports a rejected generation without selecting or resolving artifacts", async () => {
    mocks.acceptReleaseCatalog.mockReturnValueOnce(false);
    const onError = vi.fn();
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client, resolveArtifact } = createClient();

    await expect(
      checkForUpdate({ emit, client, onError, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Rejected a stale or inconsistent Release catalog",
      }),
    );
    expect(resolveArtifact).not.toHaveBeenCalled();
  });

  it("rejects mismatched catalog scope before native catalog state mutates", async () => {
    const wrongScope = createReleaseCatalogScopeKey({
      channelKey: encodeChannelKey("beta"),
      platform: "ios",
      strategy: "APP_VERSION",
    });
    const onError = vi.fn();
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient(createCatalog({ scopeKey: wrongScope }));

    await expect(
      checkForUpdate({ emit, client, onError, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Received an invalid Release catalog",
      }),
    );
    expect(mocks.acceptReleaseCatalog).not.toHaveBeenCalled();
    expect(mocks.commitReleaseSelection).not.toHaveBeenCalled();
    expect(mocks.stageBundle).not.toHaveBeenCalled();
  });

  it("rejects an unexpected Catalog identity before accepting catalog state", async () => {
    const active: PersistedSelectionReceipt = {
      catalogId: "existing-project",
      bundleId: CURRENT_BUNDLE_ID,
      catalogHash: `sha256:${"b".repeat(64)}`,
      channel: CHANNEL,
      generation: 1,
      kind: "BUNDLE",
      releaseId: ACTIVE_RELEASE_ID,
      scopeKey: createReleaseCatalogScopeKey({
        channelKey: encodeChannelKey(CHANNEL),
        platform: "ios",
        strategy: "APP_VERSION",
      }),
      selectionContextHash: "old-context",
    };
    mocks.getActiveUpdateState.mockReturnValueOnce({
      activeSelection: active,
      highestSeenCatalogs: {},
      stableSelection: active,
      verificationPending: false,
    });
    const onError = vi.fn();
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient();

    await expect(
      checkForUpdate({ emit, client, onError, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Release transition rejected: UNSOLICITED_SCOPE",
      }),
    );
    expect(mocks.acceptReleaseCatalog).not.toHaveBeenCalled();
  });
  it("reports a check that found nothing to install as UNCHANGED", async () => {
    mocks.getBundleId.mockReturnValueOnce(MINIMUM_RELEASE_ID);
    const { checkForUpdate } = await import("./checkForUpdate");
    const events = await recordPluginEvents();
    const { client } = createClient(
      createCatalog({ releases: [], rollbackReleases: [] }),
    );

    await expect(
      checkForUpdate({ emit, client, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(events).toEqual([
      [
        "onUpdateCheck",
        {
          status: "UNCHANGED",
          channel: CHANNEL,
          bundleId: MINIMUM_RELEASE_ID,
          releaseId: null,
          previousReleaseId: null,
        },
      ],
    ]);
  });

  it("treats a scope without a catalog as no update, not a failure", async () => {
    const onError = vi.fn();
    const { checkForUpdate } = await import("./checkForUpdate");
    const events = await recordPluginEvents();
    const { client, fetchReleaseCatalog } = createClient();
    fetchReleaseCatalog.mockResolvedValueOnce(null as never);

    await expect(
      checkForUpdate({ emit, client, onError, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.acceptReleaseCatalog).not.toHaveBeenCalled();
    expect(events).toEqual([
      [
        "onUpdateCheck",
        expect.objectContaining({ status: "UNCHANGED", channel: CHANNEL }),
      ],
    ]);
  });

  it.each([
    {
      label: "an HTTP status",
      error: () => new UpdateHttpError(503, "Service Unavailable"),
      expected: { reason: "http", httpStatus: 503 },
    },
    {
      label: "no response",
      error: () => new TypeError("Network request failed"),
      expected: { reason: "network" },
    },
    {
      label: "a 404 without the no-catalog mark",
      error: () => new UpdateHttpError(404, "Not Found"),
      expected: { reason: "http", httpStatus: 404 },
    },
    {
      label: "a timeout",
      error: () => new Error("Request timed out"),
      expected: { reason: "network", transport: "timeout" },
    },
    {
      label: "an invalid catalog",
      error: () =>
        new InvalidUpdateResponseError("Received an invalid Release catalog"),
      expected: { reason: "invalid_response" },
    },
  ])("reports a check failed by $label", async ({ error, expected }) => {
    const { checkForUpdate } = await import("./checkForUpdate");
    const events = await recordPluginEvents();
    const { client, fetchReleaseCatalog } = createClient();
    const cause = error();
    fetchReleaseCatalog.mockRejectedValueOnce(cause);

    await expect(
      checkForUpdate({ emit, client, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(events).toEqual([
      [
        "onUpdateError",
        {
          stage: "check",
          resource: "catalog",
          ...expected,
          channel: CHANNEL,
          bundleId: CURRENT_BUNDLE_ID,
          releaseId: null,
          updateStrategy: "appVersion",
          cause,
        },
      ],
    ]);
  });

  it.each([
    {
      label: "an artifact request answered 500",
      fail: (resolveArtifact: ReturnType<typeof vi.fn>) =>
        resolveArtifact.mockRejectedValueOnce(
          new UpdateHttpError(500, "Internal Server Error"),
        ),
      expected: {
        stage: "download",
        reason: "http",
        resource: "artifact",
        httpStatus: 500,
      },
    },
    {
      label: "native extraction",
      fail: () =>
        mocks.stageBundle.mockRejectedValueOnce(
          Object.assign(new Error("Failed to extract archive"), {
            code: "UNKNOWN_ERROR",
            userInfo: { reason: "extract", stage: "install" },
          }),
        ),
      expected: { stage: "install", reason: "extract" },
    },
    {
      label: "a native HTTP status",
      fail: () =>
        mocks.stageBundle.mockRejectedValueOnce(
          Object.assign(new Error("Failed to download bundle"), {
            code: "DOWNLOAD_FAILED",
            userInfo: {
              httpStatus: 403,
              originCode: "ExpiredToken",
              reason: "http",
              resource: "archive",
              stage: "download",
            },
          }),
        ),
      expected: {
        stage: "download",
        reason: "http",
        resource: "archive",
        httpStatus: 403,
        originCode: "ExpiredToken",
      },
    },
    {
      label: "a native connection loss",
      fail: () =>
        mocks.stageBundle.mockRejectedValueOnce(
          Object.assign(new Error("The network connection was lost."), {
            code: "DOWNLOAD_FAILED",
            userInfo: {
              reason: "network",
              resource: "file",
              stage: "download",
              transport: "connection",
            },
          }),
        ),
      expected: {
        stage: "download",
        reason: "network",
        resource: "file",
        transport: "connection",
      },
    },
  ])(
    "reports an install failed by $label and rethrows it",
    async ({ fail, expected }) => {
      const { checkForUpdate } = await import("./checkForUpdate");
      const events = await recordPluginEvents();
      const { client, resolveArtifact } = createClient();
      fail(resolveArtifact);
      const result = await checkForUpdate({
        emit,
        client,
        updateStrategy: "appVersion",
      });

      await expect(result!.updateBundle()).rejects.toThrow();

      expect(events.filter(([name]) => name === "onUpdateError")).toEqual([
        [
          "onUpdateError",
          expect.objectContaining({
            ...expected,
            channel: CHANNEL,
            bundleId: CURRENT_BUNDLE_ID,
            targetBundleId: TARGET_BUNDLE_ID,
            targetReleaseId: RELEASE_ID,
            updateStrategy: "appVersion",
          }),
        ],
      ]);
    },
  );

  it.each([
    {
      label: "a native rejection without a failure class",
      fail: () =>
        mocks.stageBundle.mockRejectedValueOnce(
          Object.assign(new Error("Release catalog selection is stale"), {
            code: "UNKNOWN_ERROR",
          }),
        ),
    },
    {
      label: "a selection that became stale",
      fail: () => mocks.isReleaseSelectionCurrent.mockReturnValueOnce(false),
    },
  ])("does not report $label as an update failure", async ({ fail }) => {
    const { checkForUpdate } = await import("./checkForUpdate");
    const events = await recordPluginEvents();
    const { client } = createClient();
    const result = await checkForUpdate({
      emit,
      client,
      updateStrategy: "appVersion",
    });
    fail();

    await expect(result!.updateBundle()).rejects.toThrow();

    expect(events.map(([name]) => name)).toEqual(["onUpdateCheck"]);
  });
});
