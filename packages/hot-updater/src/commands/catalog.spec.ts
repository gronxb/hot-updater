import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import type {
  ReleaseCatalogRow,
  ReleaseCatalogScope,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockPreflight, mockPrintBanner, mockRebuild } = vi.hoisted(
  () => ({
    mockCli: {
      loadConfig: vi.fn(),
      p: {
        confirm: vi.fn(),
        isCancel: vi.fn(() => false),
        log: {
          error: vi.fn(),
          warn: vi.fn(),
        },
      },
    },
    mockPreflight: vi.fn(),
    mockPrintBanner: vi.fn(),
    mockRebuild: vi.fn(),
  }),
);

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
  };
});

vi.mock("@hot-updater/plugin-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/plugin-core")>();
  return {
    ...actual,
    preflightReleaseCatalogRebuild: mockPreflight,
    rebuildReleaseCatalog: mockRebuild,
  };
});

vi.mock("../utils/printBanner", () => ({
  printBanner: mockPrintBanner,
}));

const channel = { id: "channel-production", name: "production" } as const;
const channelKey = encodeChannelKey(channel.name);
const appVersionScopeKey = createReleaseCatalogScopeKey({
  authorityId: "project-a",
  channelKey,
  platform: "ios",
  strategy: "APP_VERSION",
});
const fingerprintScopeKey = createReleaseCatalogScopeKey({
  authorityId: "project-a",
  channelKey,
  fingerprintHash: "fingerprint-a",
  platform: "android",
  strategy: "FINGERPRINT",
});

const releaseRow = (
  scopeKey: string,
  overrides: Partial<ReleaseRow> = {},
): ReleaseRow => ({
  bundle_id: "bundle-a",
  channel_id: channel.id,
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: scopeKey === fingerprintScopeKey ? "fingerprint-a" : null,
  id: `release-${scopeKey === fingerprintScopeKey ? "fingerprint" : "app"}`,
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: scopeKey === fingerprintScopeKey ? "android" : "ios",
  revision: 1,
  rollout_cohort_count: 1_000,
  scope_key: scopeKey,
  should_force_update: false,
  source_release_id: null,
  strategy: scopeKey === fingerprintScopeKey ? "FINGERPRINT" : "APP_VERSION",
  target_app_version: scopeKey === fingerprintScopeKey ? null : "1.0.0",
  target_cohorts: [],
  updated_at_ms: 1,
  ...overrides,
});

const catalogRow = (
  scopeKey: string,
  overrides: Partial<ReleaseCatalogRow> = {},
): ReleaseCatalogRow => ({
  authority_id: "project-a",
  byte_size: 2,
  catalog_hash: "catalog-hash",
  channel_id: channel.id,
  channel_key: channelKey,
  fingerprint_hash: scopeKey === fingerprintScopeKey ? "fingerprint-a" : null,
  generation: 1,
  is_tombstone: false,
  payload: "{}",
  platform: scopeKey === fingerprintScopeKey ? "android" : "ios",
  scope_key: scopeKey,
  strategy: scopeKey === fingerprintScopeKey ? "FINGERPRINT" : "APP_VERSION",
  updated_at_ms: 1,
  ...overrides,
});

const preflightResult = (
  scope: ReleaseCatalogScope,
  currentCatalog: ReleaseCatalogRow | null,
  changed: boolean,
) => ({
  changed,
  currentCatalog,
  diagnostics: {
    byteSize: 2,
    descriptorCount: 1,
    distinctTargetCohortCount: 0,
    releaseCount: 1,
    segmentCount: 1,
  },
  projectedCatalog: catalogRow(scope.scopeKey, {
    generation: (currentCatalog?.generation ?? 0) + (changed ? 1 : 0),
  }),
});

describe("catalog commands", () => {
  const database = {
    dispose: vi.fn(),
    models: {
      channels: { list: vi.fn() },
      releaseCatalogs: {
        findByScopeKey: vi.fn(),
        findMany: vi.fn(),
      },
      releases: {
        findMany: vi.fn(),
        findManyByScope: vi.fn(),
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCli.loadConfig.mockResolvedValue({ database });
    database.models.channels.list.mockResolvedValue({ channels: [] });
    database.models.releaseCatalogs.findByScopeKey.mockResolvedValue(null);
    database.models.releaseCatalogs.findMany.mockResolvedValue([]);
    database.models.releases.findMany.mockResolvedValue([]);
    database.models.releases.findManyByScope.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preflights an explicit scope backed only by Releases as missing", async () => {
    database.models.channels.list.mockResolvedValue({ channels: [channel] });
    database.models.releases.findManyByScope.mockResolvedValue([
      releaseRow(appVersionScopeKey),
    ]);
    mockPreflight.mockImplementation(
      ({ scope }: { scope: ReleaseCatalogScope }) =>
        preflightResult(scope, null, true),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogPreflight } = await import("./catalog");

    await handleCatalogPreflight([appVersionScopeKey], { json: true });

    expect(mockPreflight).toHaveBeenCalledWith({
      database,
      scope: {
        authorityId: "project-a",
        channelId: channel.id,
        channelName: channel.name,
        fingerprintHash: null,
        platform: "ios",
        scopeKey: appVersionScopeKey,
        strategy: "APP_VERSION",
      },
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject([
      {
        currentCatalog: null,
        projectedCatalog: { generation: 1 },
        scopeKey: appVersionScopeKey,
        state: "missing",
      },
    ]);
  });

  it("discovers the union of catalog tombstones and Release scopes", async () => {
    const tombstone = catalogRow(appVersionScopeKey, { is_tombstone: true });
    database.models.channels.list.mockResolvedValue({ channels: [channel] });
    database.models.releaseCatalogs.findMany.mockResolvedValue([tombstone]);
    database.models.releases.findMany.mockResolvedValue([
      releaseRow(fingerprintScopeKey),
    ]);
    mockPreflight.mockImplementation(
      ({ scope }: { scope: ReleaseCatalogScope }) =>
        preflightResult(
          scope,
          scope.scopeKey === appVersionScopeKey ? tombstone : null,
          scope.scopeKey !== appVersionScopeKey,
        ),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogPreflight } = await import("./catalog");

    await handleCatalogPreflight([], { json: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject([
      { scopeKey: appVersionScopeKey, state: "verified" },
      { scopeKey: fingerprintScopeKey, state: "missing" },
    ]);
  });

  it("rejects Releases that disagree with their canonical scope key", async () => {
    database.models.channels.list.mockResolvedValue({ channels: [channel] });
    database.models.releases.findManyByScope.mockResolvedValue([
      releaseRow(appVersionScopeKey, { platform: "android" }),
    ]);
    const { handleCatalogPreflight } = await import("./catalog");

    await expect(
      handleCatalogPreflight([appVersionScopeKey], { json: true }),
    ).rejects.toThrow("Releases disagree with catalog scope metadata");
    expect(mockPreflight).not.toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("rejects an explicitly requested scope with no Catalog or Releases", async () => {
    const { handleCatalogPreflight } = await import("./catalog");

    await expect(
      handleCatalogPreflight([appVersionScopeKey], { json: true }),
    ).rejects.toThrow(`Release catalog scope not found: ${appVersionScopeKey}`);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it("returns an empty result for an empty database", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogPreflight } = await import("./catalog");

    await handleCatalogPreflight([], { json: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual([]);
    expect(database.models.channels.list).not.toHaveBeenCalled();
  });

  it("rebuilds a missing Release-backed Catalog at generation one", async () => {
    database.models.channels.list.mockResolvedValue({ channels: [channel] });
    database.models.releases.findManyByScope.mockResolvedValue([
      releaseRow(appVersionScopeKey),
    ]);
    mockPreflight.mockImplementation(
      ({ scope }: { scope: ReleaseCatalogScope }) =>
        preflightResult(scope, null, true),
    );
    mockRebuild.mockImplementation(
      ({ scope }: { scope: ReleaseCatalogScope }) => ({
        attempts: 1,
        catalog: catalogRow(scope.scopeKey, { generation: 1 }),
        changed: true,
        diagnostics: preflightResult(scope, null, true).diagnostics,
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogRebuild } = await import("./catalog");

    await handleCatalogRebuild([appVersionScopeKey], {
      json: true,
      yes: true,
    });

    expect(mockRebuild).toHaveBeenCalledWith({
      database,
      scope: expect.objectContaining({ scopeKey: appVersionScopeKey }),
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject([
      {
        catalog: { generation: 1 },
        changed: true,
        previousState: "missing",
        scopeKey: appVersionScopeKey,
      },
    ]);
  });

  it("reports verified if another writer repairs a missing Catalog first", async () => {
    database.models.channels.list.mockResolvedValue({ channels: [channel] });
    database.models.releases.findManyByScope.mockResolvedValue([
      releaseRow(appVersionScopeKey),
    ]);
    mockPreflight.mockImplementation(
      ({ scope }: { scope: ReleaseCatalogScope }) =>
        preflightResult(scope, null, true),
    );
    mockRebuild.mockImplementation(
      ({ scope }: { scope: ReleaseCatalogScope }) => ({
        attempts: 1,
        catalog: catalogRow(scope.scopeKey, { generation: 1 }),
        changed: false,
        diagnostics: preflightResult(scope, null, true).diagnostics,
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogRebuild } = await import("./catalog");

    await handleCatalogRebuild([appVersionScopeKey], {
      json: false,
      yes: true,
    });

    expect(String(output.mock.calls[0]?.[0])).toContain("verified");
    expect(String(output.mock.calls[0]?.[0])).not.toContain("created");
  });
});
