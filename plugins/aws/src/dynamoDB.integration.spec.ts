import {
  type BundleEventRow,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";

const fixture = new DynamoDBIntegrationFixture();
const createPlugin = () => fixture.createPlugin();
const clearTable = () => fixture.reset();

const insightsEvent = (
  index: number,
  input: {
    readonly installId: string;
    readonly receivedAtMs: number;
    readonly type?: BundleEventRow["type"];
    readonly userId?: string | null;
  },
): BundleEventRow => {
  const type = input.type ?? "UPDATE_APPLIED";
  const base = {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    type,
    install_id: input.installId,
    user_id: input.userId ?? null,
    username: null,
    from_release_id: null,
    to_release_id: null,
    to_bundle_id: "00000000-0000-0000-0000-000000000002",
    platform: "ios" as const,
    app_version: "1.0.0",
    channel: "production",
    cohort: "0",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: input.receivedAtMs,
  };
  return type === "UNCHANGED"
    ? { ...base, type, from_bundle_id: null, update_strategy: null }
    : {
        ...base,
        type,
        from_bundle_id: "00000000-0000-0000-0000-000000000001",
        update_strategy: "appVersion",
      };
};

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

setupDatabasePluginTestSuite({
  name: "DynamoDB fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: clearTable,
  dispose: () => undefined,
});

describe("DynamoDB aggregate mutations", () => {
  beforeEach(clearTable);

  it("atomically inserts and replaces bundle patches", async () => {
    const database = createDatabaseClient(createPlugin());
    const baseBundle = {
      id: "00000000-0000-0000-0000-000000000901",
      platform: "ios",
      fileHash: "base-hash",
      gitCommitHash: null,
      storageUri: "storage://base.zip",
      archiveByteSize: 3_000_000_001,
      metadata: {},
    } as const;
    const bundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000902",
      fileHash: "bundle-hash",
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseBundle.fileHash,
          patchFileHash: "first-patch-hash",
          patchStorageUri: "storage://first.patch",
          byteSize: 3_000_000_002,
        },
      ],
    };
    await database.insertBundle(baseBundle);

    await database.insertBundle(bundle);
    await database.updateBundleById(bundle.id, {
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseBundle.fileHash,
          patchFileHash: "replacement-patch-hash",
          patchStorageUri: "storage://replacement.patch",
          byteSize: 3_000_000_003,
        },
      ],
    });

    await expect(database.getBundleById(bundle.id)).resolves.toMatchObject({
      patches: [
        {
          baseBundleId: baseBundle.id,
          patchFileHash: "replacement-patch-hash",
        },
      ],
    });
  });
});

describe("DynamoDB Insights", () => {
  beforeEach(clearTable);

  it("pages events and keeps only the latest installation identity", async () => {
    const insights = createPlugin().models.insights;
    const first = insightsEvent(1, {
      installId: "install-a",
      receivedAtMs: 100,
      userId: "user-old",
    });
    const newest = insightsEvent(4, {
      installId: "install-a",
      receivedAtMs: 400,
      type: "RECOVERED",
      userId: "user-new",
    });
    const stale = insightsEvent(2, {
      installId: "install-a",
      receivedAtMs: 200,
      userId: "user-stale",
    });
    const other = insightsEvent(3, {
      installId: "install-b",
      receivedAtMs: 300,
      type: "UNCHANGED",
    });

    await insights.append(first);
    await insights.append(newest);
    await insights.append(stale);
    await insights.append(other);

    const firstPage = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 500,
      limit: 2,
    });
    expect(firstPage.map(({ id }) => id)).toEqual([newest.id, other.id]);
    await expect(
      insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 500,
        after: {
          receivedAtMs: other.received_at_ms,
          id: other.id,
        },
        limit: 2,
      }),
    ).resolves.toEqual([stale, first]);
    await expect(
      insights.pageEvents({
        selector: {
          kind: "installationMovement",
          installId: "install-a",
        },
        beforeReceivedAtMs: 500,
        limit: 10,
      }),
    ).resolves.toEqual([newest, stale, first]);

    await expect(insights.getInstallation("install-a")).resolves.toMatchObject({
      id: newest.id,
      user_id: "user-new",
      received_at_ms: 400,
    });
    await expect(
      insights.pageInstallationsByCurrentUserId({
        userId: "user-old",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      insights.pageInstallationsByCurrentUserId({
        userId: "user-new",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: newest.id, install_id: "install-a" }),
    ]);

    await expect(
      insights.countActiveInstallations({ sinceMs: 250 }),
    ).resolves.toBe(2);
    await expect(
      insights.countActiveInstallations({ sinceMs: 350 }),
    ).resolves.toBe(1);
  });

  it("uses the event id to break equal-timestamp latest-state ties", async () => {
    const insights = createPlugin().models.insights;
    const lower = insightsEvent(10, {
      installId: "install-tie",
      receivedAtMs: 1_000,
      userId: "user-lower",
    });
    const higher = insightsEvent(11, {
      installId: "install-tie",
      receivedAtMs: 1_000,
      userId: "user-higher",
    });

    await insights.append(higher);
    await insights.append(lower);

    await expect(
      insights.getInstallation("install-tie"),
    ).resolves.toMatchObject({ id: higher.id, user_id: "user-higher" });
  });
});
