import type { DatabaseRow } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../../test-utils/test/inMemoryDatabasePlugin";
import { createBoundedAnalyticsProvider } from "./provider";

type BundleEventRow = DatabaseRow<"bundle_events">;
type AppliedEventRow = Extract<
  BundleEventRow,
  { readonly type: "UPDATE_APPLIED" }
>;
type UnchangedEventRow = Extract<
  BundleEventRow,
  { readonly type: "UNCHANGED" }
>;

const AS_OF_MS = Date.UTC(2026, 6, 17, 12);

const createEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: Partial<AppliedEventRow> = {},
): AppliedEventRow => ({
  id: `${installId}-${receivedAtMs}`,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: "old-bundle",
  to_bundle_id: "bundle-a",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

const createRecoveredEvent = (
  installId: string,
  receivedAtMs: number,
): BundleEventRow => ({
  ...createEvent(installId, receivedAtMs),
  type: "RECOVERED",
  from_bundle_id: "bundle-a",
  to_bundle_id: "fallback-bundle",
});

const createUnchangedEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: Partial<UnchangedEventRow> = {},
): UnchangedEventRow => ({
  ...createEvent(installId, receivedAtMs),
  type: "UNCHANGED",
  from_bundle_id: null,
  update_strategy: null,
  ...overrides,
});

const createProvider = async (rows: readonly BundleEventRow[]) => {
  const database = createInMemoryDatabasePlugin();
  await Promise.all(
    rows.map((data) => database.create({ model: "bundle_events", data })),
  );
  return createBoundedAnalyticsProvider(database);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bounded Analytics golden behavior", () => {
  it("preserves transition-only bundle Analytics totals and ordering", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(AS_OF_MS);
    const provider = await createProvider([
      createEvent("installed", AS_OF_MS - 4),
      createRecoveredEvent("recovered", AS_OF_MS - 3),
      createUnchangedEvent("unchanged", AS_OF_MS - 2),
    ]);

    // When
    const [summary, analytics] = await Promise.all([
      provider.getBundleEventSummary("bundle-a"),
      provider.getBundleEventAnalytics("bundle-a", "24h", 20, 0),
    ]);

    // Then
    expect(summary).toEqual({ installed: 1, recovered: 1 });
    expect(analytics.summary).toEqual({ installed: 1, recovered: 1 });
    expect(analytics.recentEvents).toMatchObject({
      data: [
        { receivedAtMs: AS_OF_MS - 3, type: "RECOVERED" },
        { receivedAtMs: AS_OF_MS - 4, type: "UPDATE_APPLIED" },
      ],
      pagination: { total: 2, limit: 20, offset: 0 },
    });
  });

  it("returns the latest state when a historical identity matches", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(AS_OF_MS);
    const provider = await createProvider([
      createEvent("install-a", AS_OF_MS - 2, {
        username: "historical-name",
        to_bundle_id: "old-bundle",
      }),
      createUnchangedEvent("install-a", AS_OF_MS - 1, {
        username: "current-name",
        to_bundle_id: "current-bundle",
      }),
    ]);

    // When
    const result = await provider.searchInstallations("historical", 20, 0);

    // Then
    expect(result).toMatchObject({
      data: [
        {
          installId: "install-a",
          username: "current-name",
          lastKnownBundleId: "current-bundle",
          latestStatus: "UNCHANGED",
        },
      ],
      pagination: { total: 1, limit: 20, offset: 0 },
    });
  });

  it("counts active install IDs once using their latest bundle and user", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(AS_OF_MS);
    const provider = await createProvider([
      createEvent("install-a", AS_OF_MS - 300, {
        user_id: "shared-user",
        to_bundle_id: "old-bundle",
      }),
      createUnchangedEvent("install-a", AS_OF_MS - 200, {
        user_id: "shared-user",
        to_bundle_id: "bundle-a",
      }),
      createUnchangedEvent("install-b", AS_OF_MS - 100, {
        user_id: "shared-user",
        to_bundle_id: "bundle-b",
      }),
    ]);

    // When
    const overview = await provider.getActiveInstallationOverview({
      window: "24h",
      userId: "shared-user",
    });

    // Then
    expect(overview).toMatchObject({
      asOfMs: AS_OF_MS,
      window: "24h",
      activeInstallations: 2,
      bundles: [
        { bundleId: "bundle-a", installations: 1 },
        { bundleId: "bundle-b", installations: 1 },
      ],
    });
  });
});
