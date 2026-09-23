import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  ReleaseCatalogMutationError,
  type ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockPrintBanner } = vi.hoisted(() => ({
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
  mockPrintBanner: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
  };
});

vi.mock("../utils/printBanner", () => ({
  printBanner: mockPrintBanner,
}));

const channel = { id: "channel-production", name: "production" } as const;
const channelKey = encodeChannelKey(channel.name);
const appVersionScopeKey = createReleaseCatalogScopeKey({
  channelKey,
  platform: "ios",
  strategy: "APP_VERSION",
});
const fingerprintScopeKey = createReleaseCatalogScopeKey({
  channelKey,
  fingerprintHash: "fingerprint-a",
  platform: "android",
  strategy: "FINGERPRINT",
});

const catalogRow = (
  scopeKey: string,
  overrides: Partial<ReleaseCatalogRow> = {},
): ReleaseCatalogRow => ({
  catalog_id: "project-a",
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
  scopeKey: string,
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
  projectedCatalog: catalogRow(scopeKey, {
    generation: (currentCatalog?.generation ?? 0) + (changed ? 1 : 0),
  }),
});

describe("catalog commands", () => {
  const core = {
    getReleaseCatalogRow: vi.fn(),
    listReleaseCatalogs: vi.fn(),
    preflightReleaseCatalogRebuild: vi.fn(),
    rebuildReleaseCatalog: vi.fn(),
  };
  const database = { dispose: vi.fn(), core };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCli.loadConfig.mockResolvedValue({ database });
    core.getReleaseCatalogRow.mockResolvedValue(null);
    core.listReleaseCatalogs.mockResolvedValue([]);
    core.preflightReleaseCatalogRebuild.mockReset();
    core.rebuildReleaseCatalog.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["preflight", "rebuild"] as const)(
    "%s refuses to replace a missing Catalog identity",
    async (command) => {
      core.getReleaseCatalogRow.mockResolvedValue(
        catalogRow(appVersionScopeKey),
      );
      const error = new ReleaseCatalogMutationError(
        "CATALOG_IDENTITY_MISSING",
        "Restore its catalog row from backup before rebuilding or deploying.",
      );
      core.preflightReleaseCatalogRebuild.mockRejectedValue(error);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const { handleCatalogPreflight, handleCatalogRebuild } =
        await import("./catalog");
      const handler =
        command === "preflight" ? handleCatalogPreflight : handleCatalogRebuild;

      await expect(
        handler([appVersionScopeKey], { json: true, yes: true }),
      ).rejects.toBe(error);

      expect(core.preflightReleaseCatalogRebuild).toHaveBeenCalledWith(
        appVersionScopeKey,
      );
      expect(core.rebuildReleaseCatalog).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(database.dispose).toHaveBeenCalledOnce();
    },
  );

  it("previews every Catalog, tombstones included, without exposing identity", async () => {
    const tombstone = catalogRow(appVersionScopeKey, { is_tombstone: true });
    const fingerprintCatalog = catalogRow(fingerprintScopeKey);
    core.listReleaseCatalogs.mockResolvedValue([tombstone, fingerprintCatalog]);
    core.preflightReleaseCatalogRebuild.mockImplementation((scopeKey: string) =>
      preflightResult(
        scopeKey,
        scopeKey === appVersionScopeKey ? tombstone : fingerprintCatalog,
        false,
      ),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogPreflight } = await import("./catalog");

    await handleCatalogPreflight([], { json: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject([
      { scopeKey: appVersionScopeKey, state: "verified" },
      { scopeKey: fingerprintScopeKey, state: "verified" },
    ]);
    expect(core.listReleaseCatalogs).toHaveBeenCalledWith({
      limit: 500,
      order: "asc",
    });
    expect(String(output.mock.calls[0]?.[0])).not.toContain("catalog_id");
    expect(String(output.mock.calls[0]?.[0])).not.toContain(
      tombstone.catalog_id,
    );
  });

  it("previews a requested scope once however often it is named", async () => {
    core.getReleaseCatalogRow.mockResolvedValue(catalogRow(appVersionScopeKey));
    core.preflightReleaseCatalogRebuild.mockImplementation((scopeKey: string) =>
      preflightResult(scopeKey, catalogRow(scopeKey), false),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogPreflight } = await import("./catalog");

    await handleCatalogPreflight([appVersionScopeKey, appVersionScopeKey], {
      json: true,
    });

    expect(core.preflightReleaseCatalogRebuild).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicitly requested scope with no Catalog", async () => {
    const { handleCatalogPreflight } = await import("./catalog");

    await expect(
      handleCatalogPreflight([appVersionScopeKey], { json: true }),
    ).rejects.toThrow(`Release catalog scope not found: ${appVersionScopeKey}`);
    expect(core.preflightReleaseCatalogRebuild).not.toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("returns an empty result for an empty database", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogPreflight } = await import("./catalog");

    await handleCatalogPreflight([], { json: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual([]);
  });

  it("rebuilds a damaged Catalog without exposing its identity", async () => {
    const current = catalogRow(appVersionScopeKey, {
      generation: 3,
      payload: "corrupted",
    });
    core.getReleaseCatalogRow.mockResolvedValue(current);
    core.preflightReleaseCatalogRebuild.mockImplementation((scopeKey: string) =>
      preflightResult(scopeKey, current, true),
    );
    core.rebuildReleaseCatalog.mockImplementation((scopeKey: string) => ({
      attempts: 1,
      catalog: catalogRow(scopeKey, { generation: 4 }),
      changed: true,
      diagnostics: preflightResult(scopeKey, current, true).diagnostics,
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleCatalogRebuild } = await import("./catalog");

    await handleCatalogRebuild([appVersionScopeKey], {
      json: true,
      yes: true,
    });

    expect(core.rebuildReleaseCatalog).toHaveBeenCalledWith(appVersionScopeKey);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject([
      {
        catalog: { generation: 4 },
        changed: true,
        previousState: "rebuild required",
        scopeKey: appVersionScopeKey,
      },
    ]);
    expect(String(output.mock.calls[0]?.[0])).not.toContain("catalog_id");
    expect(String(output.mock.calls[0]?.[0])).not.toContain(current.catalog_id);
  });

  it("reports verified if another writer repairs the projection first", async () => {
    const current = catalogRow(appVersionScopeKey, { payload: "corrupted" });
    core.getReleaseCatalogRow.mockResolvedValue(current);
    core.preflightReleaseCatalogRebuild.mockImplementation((scopeKey: string) =>
      preflightResult(scopeKey, current, true),
    );
    core.rebuildReleaseCatalog.mockImplementation((scopeKey: string) => ({
      attempts: 1,
      catalog: catalogRow(scopeKey, { generation: 2 }),
      changed: false,
      diagnostics: preflightResult(scopeKey, current, true).diagnostics,
    }));
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
