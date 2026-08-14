import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterResolver } from "./types";

const MINIMUM_RELEASE_ID = "00000000-0000-7000-8000-000000000001";
const RELEASE_ID = "00000000-0000-7000-8000-000000000002";
const CURRENT_BUNDLE_ID = "00000000-0000-7001-8000-000000000001";
const TARGET_BUNDLE_ID = "00000000-0000-7001-8000-000000000002";
const AUTHORITY_ID = "project-a";
const CHANNEL = "production";
const CATALOG_HASH = `sha256:${"a".repeat(64)}`;
const SCOPE_KEY = createReleaseCatalogScopeKey({
  authorityId: AUTHORITY_ID,
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
  getMinBundleId: vi.fn(() => MINIMUM_RELEASE_ID),
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
  authorityId: AUTHORITY_ID,
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

const createResolver = (catalog = createCatalog()) => {
  const fetchReleaseCatalog = vi.fn(async () => catalog);
  const resolveArtifact = vi.fn(async () => ({
    fileHash: "bundle-hash",
    fileUrl: "https://updates.example.com/bundle.zip",
    id: TARGET_BUNDLE_ID,
    message: null,
    shouldForceUpdate: false,
    status: "UPDATE" as const,
  }));
  const resolver: HotUpdaterResolver = {
    authorityId: AUTHORITY_ID,
    fetchReleaseCatalog,
    resolveArtifact,
  };
  return { fetchReleaseCatalog, resolveArtifact, resolver };
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
    const { fetchReleaseCatalog, resolveArtifact, resolver } = createResolver();

    const result = await checkForUpdate({
      resolver,
      updateStrategy: "appVersion",
    });

    expect(result).toMatchObject({
      id: TARGET_BUNDLE_ID,
      releaseId: RELEASE_ID,
      transitionKind: "INSTALL",
    });
    expect(fetchReleaseCatalog).toHaveBeenCalledWith({
      appVersion: "1.2.0",
      authorityId: AUTHORITY_ID,
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
          releaseId: RELEASE_ID,
          scopeKey: SCOPE_KEY,
        }),
      }),
    );
  });

  it("adopts a newer Release for the same Bundle without resolving bytes", async () => {
    const active: PersistedSelectionReceipt = {
      authorityId: AUTHORITY_ID,
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
    const { resolveArtifact, resolver } = createResolver();

    const result = await checkForUpdate({
      resolver,
      updateStrategy: "appVersion",
    });

    expect(result?.transitionKind).toBe("ADOPT_RELEASE");
    await expect(result?.updateBundle()).resolves.toBe(true);
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(mocks.updateBundle).not.toHaveBeenCalled();
    expect(mocks.commitReleaseSelection).toHaveBeenCalledWith({
      guard: expect.objectContaining({ generation: 2, scopeKey: SCOPE_KEY }),
      selection: expect.objectContaining({
        bundleId: TARGET_BUNDLE_ID,
        releaseId: RELEASE_ID,
      }),
    });
  });

  it("does not adopt the same Release merely to refresh catalog provenance", async () => {
    const active: PersistedSelectionReceipt = {
      authorityId: AUTHORITY_ID,
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
    const { resolveArtifact, resolver } = createResolver();

    await expect(
      checkForUpdate({ resolver, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(mocks.updateBundle).not.toHaveBeenCalled();
    expect(mocks.commitReleaseSelection).not.toHaveBeenCalled();
  });

  it("rejects a slow artifact completion after a newer catalog wins", async () => {
    mocks.isReleaseSelectionCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const { StaleReleaseCatalogError } = await import("./error");
    const { checkForUpdate } = await import("./checkForUpdate");
    const { resolver } = createResolver();
    const result = await checkForUpdate({
      resolver,
      updateStrategy: "appVersion",
    });

    await expect(result?.updateBundle()).rejects.toBeInstanceOf(
      StaleReleaseCatalogError,
    );
    expect(mocks.updateBundle).not.toHaveBeenCalled();
  });

  it("reports a rejected generation without selecting or resolving artifacts", async () => {
    mocks.acceptReleaseCatalog.mockReturnValueOnce(false);
    const onError = vi.fn();
    const { checkForUpdate } = await import("./checkForUpdate");
    const { resolveArtifact, resolver } = createResolver();

    await expect(
      checkForUpdate({ onError, resolver, updateStrategy: "appVersion" }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Rejected a stale or inconsistent Release catalog",
      }),
    );
    expect(resolveArtifact).not.toHaveBeenCalled();
  });
});
