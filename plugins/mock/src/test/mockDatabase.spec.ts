import {
  createDatabaseClient,
  type BundleEventRow,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  setupDatabasePluginTestSuite,
  setupDatabaseClientTestSuite,
} from "../../../../packages/test-utils/src/index";
import {
  createMockDatabaseData,
  mockDatabase,
  type MockDatabaseData,
} from "../mockDatabase";

const DEFAULT_LATENCY = { min: 0, max: 0 } as const;
const INSIGHTS_NAMESPACES = {
  insightsDatabaseNamespace: "00000000-0000-7000-8000-00000000d001",
  otherInsightsDatabaseNamespace: "00000000-0000-7000-8000-00000000d002",
} as const;

let data: MockDatabaseData;

const resetData = (): void => {
  data.bundles.clear();
  data.bundlePatches.clear();
  data.channels.clear();
  data.apiKeys.clear();
  data.releaseCatalogs.clear();
  data.releases.clear();
};

const createPlugin = (): DatabasePlugin =>
  mockDatabase({
    ...INSIGHTS_NAMESPACES,
    data,
    latency: DEFAULT_LATENCY,
  });

beforeEach(() => {
  resetData();
});

data = createMockDatabaseData(INSIGHTS_NAMESPACES);

setupDatabasePluginTestSuite({
  name: "mock fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: resetData,
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "mock database aggregate client",
  createPlugin,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: resetData,
  dispose: () => undefined,
});

describe("mock database provider", () => {
  it("rejects data from a different Insights namespace before creating the plugin", () => {
    expect(() =>
      mockDatabase({
        ...INSIGHTS_NAMESPACES,
        insightsDatabaseNamespace: "00000000-0000-7000-8000-00000000d003",
        data,
        latency: DEFAULT_LATENCY,
      }),
    ).toThrow("Mock Insights database namespaces do not match data");
  });

  it("exposes all Insights reads with bounded controllable maintenance", async () => {
    const plugin = createPlugin();
    const dayMs = 86_400_000;
    const nowMs = 31 * dayMs;
    const event: BundleEventRow = {
      id: "00000000-0000-7000-8000-000000000e01",
      type: "UPDATE_APPLIED",
      install_id: "public-cutover-installation",
      user_id: "public-cutover-user",
      username: "Public Cutover",
      from_bundle_id: "10000000-0000-7000-8000-000000000001",
      from_release_id: null,
      to_bundle_id: "10000000-0000-7000-8000-000000000002",
      to_release_id: null,
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort: "default",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: nowMs - 1_000,
    };
    data.insights.setCurrentTimeMs(nowMs);
    await plugin.models.insights.append(event);

    const events = await plugin.models.insights.pageEvents({
      selector: { kind: "installationId", installId: event.install_id },
      beforeReceivedAtMs: nowMs,
      limit: 10,
    });
    expect(events).toMatchObject({
      state: "ready",
      data: { data: [{ id: event.id }], nextCursor: null },
    });
    await expect(
      plugin.models.insights.pageInstallations({
        kind: "installationId",
        installId: event.install_id,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ install_id: event.install_id }], nextCursor: null },
    });

    const searchInput = {
      kind: "contains" as const,
      query: event.install_id,
      limit: 10,
    };
    const preparingSearch =
      await plugin.models.insights.pageInstallations(searchInput);
    expect(preparingSearch.state).toBe("preparing");
    if (preparingSearch.state !== "preparing") {
      throw new Error("expected search preparation");
    }
    const searchStep = await data.insights.runJobStep(preparingSearch.job.id, {
      maxItems: 10,
      maxRequests: 1,
    });
    expect(searchStep.state).toBe("complete");
    expect(searchStep.usage.items).toBeGreaterThan(0);
    expect(searchStep.usage.items).toBeLessThanOrEqual(10);
    expect(searchStep.usage.requests).toBe(1);
    await expect(
      createPlugin().models.insights.pageInstallations(searchInput),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ install_id: event.install_id }], nextCursor: null },
    });

    const reportInput = {
      query: {
        kind: "activeOverview" as const,
        window: "7d" as const,
        userId: event.user_id!,
      },
    };
    const preparingReport = await plugin.models.insights.getReport(reportInput);
    expect(preparingReport.state).toBe("preparing");
    if (preparingReport.state !== "preparing") {
      throw new Error("expected report preparation");
    }
    const reportStep = await data.insights.runJobStep(preparingReport.job.id, {
      maxItems: 10,
      maxRequests: 1,
    });
    expect(reportStep.state).toBe("complete");
    expect(reportStep.usage.items).toBeGreaterThan(0);
    expect(reportStep.usage.items).toBeLessThanOrEqual(10);
    expect(reportStep.usage.requests).toBe(1);
    const report = await plugin.models.insights.getReport(reportInput);
    expect(report).toMatchObject({
      state: "ready",
      data: { kind: "activeOverview", summary: { activeInstallations: 1 } },
    });
    if (report.state !== "ready" && report.state !== "stale") {
      throw new Error("expected published report");
    }
    await expect(
      plugin.models.insights.pageReport({
        publicationId: report.data.id,
        section: "activeSeries",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { section: "activeSeries" },
    });
  });

  it("serializes concurrent channel inserts and returns the canonical row", async () => {
    const plugin = createPlugin();

    const results = await Promise.all([
      plugin.models.channels.insert({
        row: { id: "mock-channel-a", name: "production" },
        onConflict: "returnExisting",
      }),
      plugin.models.channels.insert({
        row: { id: "mock-channel-b", name: "production" },
        onConflict: "returnExisting",
      }),
    ]);

    expect(results).toEqual([
      {
        row: { id: "mock-channel-a", name: "production" },
        inserted: true,
      },
      {
        row: { id: "mock-channel-a", name: "production" },
        inserted: false,
      },
    ]);
    expect(data.channels).toEqual(
      new Map([
        ["mock-channel-a", { id: "mock-channel-a", name: "production" }],
      ]),
    );
  });

  it("rolls back all table changes when an atomic batch rejects", async () => {
    const plugin = createPlugin();
    const row = {
      id: "bundle-rollback",
      platform: "ios" as const,
      file_hash: "hash",
      git_commit_hash: null,
      storage_uri: "storage://bundle.zip",
      archive_byte_size: 3_000_000_001,
      metadata: {},
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: "channel-rollback", name: "rollback" },
            onConflict: "ignore",
          },
          {
            model: "bundles",
            operation: "insert",
            row,
          },
          {
            model: "bundlePatches",
            operation: "insert",
            row: {
              id: "invalid-patch",
              bundle_id: "invalid-owner",
              base_bundle_id: row.id,
              base_file_hash: row.file_hash,
              patch_file_hash: "patch-hash",
              patch_storage_uri: "storage://patch",
              byte_size: 3_000_000_002,
              order_index: 0,
            },
          },
        ],
      }),
    ).rejects.toThrow("foreign-key");

    await expect(plugin.models.bundles.findById(row.id)).resolves.toBeNull();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });
});
