import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterHttpClient } from "./httpClient";

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

const mocks = vi.hoisted(() => ({
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
  getPersistedUserIdentity: vi.fn(() => ({})),
  isChannelSwitched: vi.fn(() => false),
  isReleaseSelectionCurrent: vi.fn(() => true),
  resetChannel: vi.fn(),
  updateBundle: vi.fn(async () => true),
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("./native", () => mocks);

const createCatalog = (
  overrides: Partial<ReleaseCatalog> = {},
): ReleaseCatalog => ({
  catalogId: CATALOG_ID,
  catalogHash: CATALOG_HASH,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 2,
  releases: [
    {
      bundleId: TARGET_BUNDLE_ID,
      kind: "BUNDLE",
      message: "Release two",
      releaseId: RELEASE_ID,
      rolloutCohortCount: 1000,
      shouldForceUpdate: false,
      targetCohorts: [],
    },
  ],
  schemaVersion: 1,
  scopeKey: SCOPE_KEY,
  ...overrides,
});

const createClient = (catalog = createCatalog()) => {
  const fetchReleaseCatalog = vi.fn(async () => catalog);
  const resolveArtifact = vi.fn(async () => ({
    fileHash: "bundle-hash",
    fileUrl: "https://updates.example.com/bundle.zip",
  }));
  const sendInsightsEvent = vi.fn(async () => undefined);
  const session = {
    fetchReleaseCatalog,
    resolveArtifact,
    sendInsightsEvent,
  };
  const client: HotUpdaterHttpClient = {
    createSession: vi.fn(async () => session),
  };
  return { client, fetchReleaseCatalog, resolveArtifact, sendInsightsEvent };
};

describe("checkForUpdate Release catalog protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.updateBundle.mockResolvedValue(true);
  });

  it("selects locally and defers Bundle artifact resolution until install", async () => {
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client, fetchReleaseCatalog, resolveArtifact } = createClient();

    const result = await checkForUpdate({
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
    expect(mocks.updateBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
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
    const { client, resolveArtifact, sendInsightsEvent } =
      createClient(forceCatalog);

    const result = await checkForUpdate({
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
    expect(mocks.updateBundle).not.toHaveBeenCalled();
    expect(sendInsightsEvent).not.toHaveBeenCalled();
    expect(mocks.commitReleaseSelection).toHaveBeenCalledWith({
      guard: expect.objectContaining({ generation: 2, scopeKey: SCOPE_KEY }),
      selection: expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
        releaseId: RELEASE_ID,
      }),
    });
  });

  it("sends RELEASE_ADOPTED only when insights is enabled", async () => {
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
    const { client, sendInsightsEvent } = createClient();

    const result = await checkForUpdate({
      insights: true,
      client,
      updateStrategy: "appVersion",
    });
    await result?.updateBundle();

    expect(sendInsightsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBundleId: TARGET_BUNDLE_ID,
        fromReleaseId: MINIMUM_RELEASE_ID,
        toBundleId: TARGET_BUNDLE_ID,
        toReleaseId: RELEASE_ID,
        type: "RELEASE_ADOPTED",
      }),
    );
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
    expect(mocks.updateBundle).not.toHaveBeenCalled();
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
      client,
      updateStrategy: "appVersion",
    });

    await expect(result?.updateBundle()).rejects.toBeInstanceOf(
      StaleReleaseCatalogError,
    );
    expect(mocks.updateBundle).not.toHaveBeenCalled();
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
    expect(mocks.updateBundle).toHaveBeenCalledWith(
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
      expect(mocks.updateBundle).not.toHaveBeenCalled();
    },
  );

  it("does not surface a rollback when the app already uses built-in bytes", async () => {
    mocks.getBundleId.mockReturnValueOnce(MINIMUM_RELEASE_ID);
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client } = createClient(
      createCatalog({ releases: [], rollbackReleases: [] }),
    );

    await expect(
      checkForUpdate({ client, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();
    expect(mocks.commitReleaseSelection).not.toHaveBeenCalled();
  });

  it("reports a rejected generation without selecting or resolving artifacts", async () => {
    mocks.acceptReleaseCatalog.mockReturnValueOnce(false);
    const onError = vi.fn();
    const { checkForUpdate } = await import("./checkForUpdate");
    const { client, resolveArtifact } = createClient();

    await expect(
      checkForUpdate({ client, onError, updateStrategy: "appVersion" }),
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
      checkForUpdate({ client, onError, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Received an invalid Release catalog",
      }),
    );
    expect(mocks.acceptReleaseCatalog).not.toHaveBeenCalled();
    expect(mocks.commitReleaseSelection).not.toHaveBeenCalled();
    expect(mocks.updateBundle).not.toHaveBeenCalled();
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
      checkForUpdate({ client, onError, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Release transition rejected: UNSOLICITED_SCOPE",
      }),
    );
    expect(mocks.acceptReleaseCatalog).not.toHaveBeenCalled();
  });
});
