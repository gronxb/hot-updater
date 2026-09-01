import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertInsightsCursorContract,
  assertInsightsEventContract,
  assertInsightsExpiredReadContract,
  assertInsightsFailedReadContract,
  assertInsightsInstallationIdentityMatch,
  assertInsightsInstallationIdentityDigest,
  assertInsightsMaintenanceInputContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  assertInsightsQueryContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  assertInsightsResponseContract,
  canonicalInsightsJson,
  compareInsightsInstallationOrderKeys,
  compareInsightsStrings,
  getInsightsInstallationOrderKey,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_CURSOR_MAX_BYTES,
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_MAX_ITEMS,
  INSIGHTS_MAINTENANCE_MAX_REQUESTS,
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_QUERY_MAX_BYTES,
  isCanonicalInsightsEventId,
} from "./insightsContract";
import type { BundleEventRow } from "./types/databaseRows";

const validEventId = "00000000-0000-7000-8000-000000000001";

const event: BundleEventRow = {
  id: validEventId,
  type: "UPDATE_APPLIED",
  install_id: "install-1",
  user_id: null,
  username: null,
  from_bundle_id: "bundle-1",
  from_release_id: null,
  to_bundle_id: "bundle-2",
  to_release_id: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "0",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: 1,
};

const versions = {
  schemaVersion: "schema-1",
  storageVersion: "storage-1",
  projectionGeneration: "projection-1",
  sourceGeneration: "source-1",
} as const;

const eventVersions = {
  ...versions,
  projectionGeneration: null,
} as const;

const publication = {
  id: "publication-1",
  asOfMs: 100,
  completedAtMs: 101,
  sourceGeneration: versions.sourceGeneration,
  accuracy: "exact",
} as const;

const valueAtSize = <TFields extends object>(
  maxBytes: number,
  fields: TFields,
): TFields & { padding: string[] } => {
  const empty = { ...fields, padding: [] as string[] };
  const delta = maxBytes - getCanonicalInsightsJsonByteLength(empty);
  const chunkCount = Math.ceil((delta + 1) / 1003);
  let remainingCharacters = delta - chunkCount * 3 + 1;
  const padding = Array.from({ length: chunkCount }, (_, index) => {
    const remainingChunks = chunkCount - index - 1;
    const length = Math.min(1000, remainingCharacters - remainingChunks);
    remainingCharacters -= length;
    return "a".repeat(length);
  });
  if (remainingCharacters !== 0 || padding.some((item) => item.length < 1)) {
    throw new Error("Cannot construct exact canonical JSON fixture size");
  }
  const value = { ...fields, padding };
  expect(getCanonicalInsightsJsonByteLength(value)).toBe(maxBytes);
  return value;
};

const eventAt = (index: number): BundleEventRow => ({
  ...event,
  id: `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
  received_at_ms: 10_000 - index,
});

const eventPage = (data: readonly BundleEventRow[]) => ({
  state: "ready" as const,
  versions: eventVersions,
  data: {
    data,
    nextCursor: null,
    hasNext: false,
    consistency: {
      kind: "live" as const,
      cutoff: {
        kind: "event-time" as const,
        beforeReceivedAtMs: 20_000,
      },
    },
    total: { state: "unavailable" as const },
  },
});

const exactSizeEventPage = (targetBytes: number) => {
  const emptyBytes = getCanonicalInsightsJsonByteLength(eventPage([]));
  const minimumEventBytes = getCanonicalInsightsJsonByteLength(eventAt(1));
  const count = Math.ceil(
    (targetBytes - emptyBytes + 1) / (INSIGHTS_EVENT_MAX_BYTES + 1),
  );
  const availableEventBytes = targetBytes - emptyBytes - (count - 1);
  const sizes = Array.from({ length: count }, () => minimumEventBytes);
  let remaining = availableEventBytes - minimumEventBytes * count;
  for (let index = 0; index < sizes.length && remaining > 0; index += 1) {
    const added = Math.min(
      INSIGHTS_EVENT_MAX_BYTES - minimumEventBytes,
      remaining,
    );
    sizes[index]! += added;
    remaining -= added;
  }
  expect(remaining).toBe(0);
  const rows = sizes.map((size, index) =>
    valueAtSize(size, eventAt(index + 1)),
  );
  const page = eventPage(rows);
  expect(getCanonicalInsightsJsonByteLength(page)).toBe(targetBytes);
  return page;
};

describe("Insights storage contract", () => {
  it("accepts only canonical lowercase UUIDv7 event IDs", () => {
    expect(isCanonicalInsightsEventId(validEventId)).toBe(true);
    expect(
      isCanonicalInsightsEventId("00000000-0000-6000-8000-000000000001"),
    ).toBe(false);
    expect(
      isCanonicalInsightsEventId("00000000-0000-7000-A000-000000000001"),
    ).toBe(false);
  });

  it("validates the complete event row before accepting UUID and bytes", () => {
    expect(() =>
      assertInsightsEventContract({ id: validEventId }),
    ).toThrowError("invalid-event");
    expect(() =>
      assertInsightsEventContract({ ...event, install_id: 1 }),
    ).toThrowError("invalid-event");
    expect(() => assertInsightsEventContract(event)).not.toThrow();
  });

  it("canonicalizes nested JSON with sorted object keys", () => {
    expect(canonicalInsightsJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
  });

  it("enforces exact event, query, page, and maintenance byte ceilings", () => {
    const boundedEvent = valueAtSize(INSIGHTS_EVENT_MAX_BYTES, event);
    expect(() => assertInsightsEventContract(boundedEvent)).not.toThrow();
    expect(() =>
      assertInsightsEventContract({
        ...boundedEvent,
        padding: [...boundedEvent.padding, "a"],
      }),
    ).toThrowError("event-too-large");

    const boundedQuery = valueAtSize(INSIGHTS_QUERY_MAX_BYTES, {});
    expect(() => assertInsightsQueryContract(boundedQuery)).not.toThrow();
    expect(() =>
      assertInsightsQueryContract({
        ...boundedQuery,
        padding: [...boundedQuery.padding, "a"],
      }),
    ).toThrowError("query-too-large");

    const boundedPage = exactSizeEventPage(INSIGHTS_PAGE_MAX_BYTES);
    expect(() => assertInsightsPageContract(boundedPage, 100)).not.toThrow();
    expect(() =>
      assertInsightsPageContract(
        eventPage([...boundedPage.data.data, eventAt(100)]),
        100,
      ),
    ).toThrowError("page-too-large");

    const boundedStep = valueAtSize(INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES, {
      maxItems: 1,
      maxRequests: 1,
    });
    expect(() =>
      assertInsightsMaintenanceInputContract(boundedStep),
    ).not.toThrow();
    expect(() =>
      assertInsightsMaintenanceInputContract({
        ...boundedStep,
        padding: [...boundedStep.padding, "a"],
      }),
    ).toThrowError("maintenance-input-too-large");
  });

  it("caps maintenance work independently of serialized input size", () => {
    expect(() =>
      assertInsightsMaintenanceInputContract({
        maxItems: INSIGHTS_MAINTENANCE_MAX_ITEMS,
        maxRequests: INSIGHTS_MAINTENANCE_MAX_REQUESTS,
      }),
    ).not.toThrow();
    expect(() =>
      assertInsightsMaintenanceInputContract({
        maxItems: INSIGHTS_MAINTENANCE_MAX_ITEMS + 1,
        maxRequests: 1,
      }),
    ).toThrowError("invalid-maintenance-input");
    expect(() =>
      assertInsightsMaintenanceInputContract({
        maxItems: 1,
        maxRequests: INSIGHTS_MAINTENANCE_MAX_REQUESTS + 1,
      }),
    ).toThrowError("invalid-maintenance-input");
  });

  it("validates ready event cutoff, order, total, and generation", () => {
    const first = eventAt(1);
    const second = eventAt(2);
    expect(() =>
      assertInsightsPageContract(eventPage([first, second]), 2),
    ).not.toThrow();
    expect(() =>
      assertInsightsPageContract({ ...eventPage([first]), versions }, 1),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(eventPage([second, first]), 2),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(eventPage([first, second]), 1),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          data: {
            ...eventPage([first]).data,
            nextCursor: "a".repeat(1025),
            hasNext: true,
          },
        },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          data: {
            ...eventPage([first]).data,
            nextCursor: "",
            hasNext: true,
          },
        },
        1,
      ),
    ).toThrowError("invalid-json");
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          state: "stale",
          refresh: { id: "job-1" },
        },
        1,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          data: {
            ...eventPage([first]).data,
            total: { state: "pending", jobId: "total-job-1" },
          },
        },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          data: {
            ...eventPage([first]).data,
            total: { state: "pending" },
          },
        },
        1,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          data: {
            ...eventPage([first]).data,
            total: {
              state: "exact",
              value: 1,
              sourceGeneration: "wrong-generation",
            },
          },
        },
        1,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        {
          ...eventPage([first]),
          data: {
            ...eventPage([first]).data,
            total: {
              state: "exact",
              value: 0,
              sourceGeneration: versions.sourceGeneration,
            },
          },
        },
        1,
      ),
    ).toThrowError("invalid-page");
  });

  it("requires publication and exact-total generation on historical pages", () => {
    const installation = {
      id: event.id,
      install_id: event.install_id,
      user_id: event.user_id,
      username: event.username,
      to_bundle_id: event.to_bundle_id,
      type: event.type,
      platform: event.platform,
      app_version: event.app_version,
      channel: event.channel,
      cohort: event.cohort,
      received_at_ms: event.received_at_ms,
    };
    const page = {
      state: "stale" as const,
      versions,
      refresh: { id: "job-2" },
      data: {
        data: [installation],
        nextCursor: null,
        hasNext: false,
        consistency: {
          kind: "snapshot" as const,
          cutoff: { kind: "publication" as const, publication },
        },
        total: {
          state: "exact" as const,
          value: 1,
          sourceGeneration: versions.sourceGeneration,
        },
      },
    };
    expect(() => assertInsightsPageContract(page, 1)).not.toThrow();
    expect(() =>
      assertInsightsPageContract(
        {
          ...page,
          versions: { ...versions, projectionGeneration: null },
        },
        1,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        {
          ...page,
          data: { ...page.data, total: { state: "unavailable" } },
        },
        1,
      ),
    ).toThrowError("invalid-page");
  });

  it("validates each non-page state and ready report publication", () => {
    const preparing = {
      state: "preparing" as const,
      versions,
      job: { id: "job-1" },
    };
    const failed = {
      state: "failed" as const,
      versions,
      error: { code: "migration-poison" as const, jobId: "job-1" },
    };
    const expired = {
      state: "expired" as const,
      publicationId: "publication-1",
    };
    const ready = {
      state: "ready" as const,
      versions,
      data: {
        ...publication,
        kind: "bundleSummaries" as const,
        summary: [
          { bundleId: "bundle-a", installed: 1, recovered: 0 },
          { bundleId: "bundle-b", installed: 0, recovered: 1 },
        ],
      },
    };

    expect(() => assertInsightsPreparingReadContract(preparing)).not.toThrow();
    expect(() => assertInsightsFailedReadContract(failed)).not.toThrow();
    expect(() =>
      assertInsightsFailedReadContract({
        ...failed,
        versions: {
          schemaVersion: null,
          storageVersion: null,
          projectionGeneration: null,
          sourceGeneration: null,
        },
      }),
    ).not.toThrow();
    expect(() => assertInsightsExpiredReadContract(expired)).not.toThrow();
    expect(() => assertInsightsReportResultContract(ready)).not.toThrow();
    for (const value of [preparing, failed, expired, ready]) {
      expect(() => assertInsightsResponseContract(value)).not.toThrow();
    }
    expect(() =>
      assertInsightsResponseContract({
        ...preparing,
        versions: { ...versions, sourceGeneration: "" },
      }),
    ).toThrowError("invalid-response");
    expect(() =>
      assertInsightsPreparingReadContract({
        ...preparing,
        versions: { ...versions, sourceGeneration: null },
      }),
    ).toThrowError("invalid-response");
    expect(() =>
      assertInsightsResponseContract({
        ...failed,
        error: { code: "migration-poison" },
      }),
    ).toThrowError("invalid-response");
    expect(() =>
      assertInsightsReportResultContract({
        ...ready,
        data: {
          ...ready.data,
          summary: [...ready.data.summary].reverse(),
        },
      }),
    ).toThrowError("invalid-response");
  });

  it("accepts only ready, failed, or expired report-page states", () => {
    const ready = {
      state: "ready" as const,
      versions,
      data: {
        section: "activeSeries" as const,
        data: [{ bucketStartMs: 0, value: 1 }],
        nextCursor: null,
        hasNext: false,
        consistency: {
          kind: "snapshot" as const,
          cutoff: { kind: "publication" as const, publication },
        },
        total: {
          state: "exact" as const,
          value: 1,
          sourceGeneration: versions.sourceGeneration,
        },
      },
    };
    expect(() =>
      assertInsightsReportPageResultContract(ready, 1),
    ).not.toThrow();
    expect(() =>
      assertInsightsReportPageResultContract(
        {
          state: "failed",
          versions,
          error: { code: "storage-corruption" },
        },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertInsightsReportPageResultContract(
        {
          state: "expired",
          publicationId: publication.id,
        },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertInsightsReportPageResultContract(
        {
          state: "preparing",
          versions,
          job: { id: "job-1" },
        },
        1,
      ),
    ).toThrowError("invalid-response");
  });

  it("rejects report rows that violate the fixed within-page order", () => {
    const reportPage = (section: string, data: readonly unknown[]) => ({
      state: "ready" as const,
      versions,
      data: {
        section,
        data,
        nextCursor: null,
        hasNext: false,
        consistency: {
          kind: "snapshot" as const,
          cutoff: { kind: "publication" as const, publication },
        },
        total: {
          state: "exact" as const,
          value: data.length,
          sourceGeneration: versions.sourceGeneration,
        },
      },
    });
    expect(() =>
      assertInsightsPageContract(
        reportPage("activeSeries", [
          { bucketStartMs: 2, value: 1 },
          { bucketStartMs: 1, value: 1 },
        ]),
        2,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        reportPage("movementCohorts", [
          { cohort: "é", value: 2 },
          { cohort: "e\u0301", value: 1 },
        ]),
        2,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        reportPage("bundleDistribution", [
          { bundleId: "bundle-a", installations: 1 },
          { bundleId: "bundle-b", installations: 2 },
        ]),
        2,
      ),
    ).toThrowError("invalid-page");
    expect(() =>
      assertInsightsPageContract(
        reportPage("activeBundleSeries", [
          { bundleId: "bundle-a", bucketStartMs: 1, value: 1 },
          { bundleId: "bundle-b", bucketStartMs: 1, value: 1 },
          { bundleId: "bundle-a", bucketStartMs: 2, value: 1 },
        ]),
        3,
      ),
    ).toThrowError("invalid-page");
  });

  it("measures cursor UTF-8 bytes and rejects malformed UTF-16", () => {
    expect(() => assertInsightsCursorContract("")).toThrowError("invalid-json");
    expect(() =>
      assertInsightsCursorContract("é".repeat(INSIGHTS_CURSOR_MAX_BYTES / 2)),
    ).not.toThrow();
    expect(() =>
      assertInsightsCursorContract(
        `é${"a".repeat(INSIGHTS_CURSOR_MAX_BYTES - 1)}`,
      ),
    ).toThrowError("cursor-too-large");
    expect(() => assertInsightsCursorContract("\ud800")).toThrowError(
      "invalid-unicode",
    );
  });

  it("rejects overlong or malformed strings outside opaque cursors", () => {
    expect(() =>
      assertInsightsQueryContract({ value: "a".repeat(1025) }),
    ).toThrowError("string-too-long");
    expect(() => assertInsightsQueryContract({ value: "\udc00" })).toThrowError(
      "invalid-unicode",
    );
    expect(() =>
      assertInsightsQueryContract({ value: "nul\0text" }),
    ).toThrowError("unsupported-string");
    expect(() => assertInsightsCursorContract("cursor\0value")).toThrowError(
      "unsupported-string",
    );
  });

  it("publishes native JSON.stringify installation hash vectors", async () => {
    for (const vector of INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS) {
      expect(JSON.stringify(vector.installId)).toBe(vector.json);
      expect(createHash("sha256").update(vector.json).digest("hex")).toBe(
        vector.sha256Hex,
      );
      expect(
        Buffer.from(
          await getInsightsInstallationOrderKey(vector.installId),
        ).toString("hex"),
      ).toBe(vector.sha256Hex);
    }
    expect(INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS.at(-2)?.sha256Hex).not.toBe(
      INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS.at(-1)?.sha256Hex,
    );
    expect(
      compareInsightsInstallationOrderKeys(
        await getInsightsInstallationOrderKey("é"),
        await getInsightsInstallationOrderKey("e\u0301"),
      ),
    ).not.toBe(0);
    await expect(
      getInsightsInstallationOrderKey("nul\0identity"),
    ).rejects.toThrow("unsupported-string");
  });

  it("uses exact JavaScript string order without locale collation", () => {
    const labels = ["é", "e\u0301", "𐐀", "Z", "z", "\u2028"];
    expect([...labels].sort(compareInsightsStrings)).toEqual(
      [...labels].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    expect(compareInsightsStrings("é", "e\u0301")).not.toBe(0);
  });

  it("detects digest/full-ID mismatches before merging identities", () => {
    const expected = {
      digestHex: INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS[1].sha256Hex,
      installId: INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS[1].installId,
    };
    expect(() =>
      assertInsightsInstallationIdentityMatch(expected, expected),
    ).not.toThrow();
    expect(() =>
      assertInsightsInstallationIdentityMatch(expected, {
        ...expected,
        installId: "different-installation",
      }),
    ).toThrowError("installation-identity-collision");
    expect(() =>
      assertInsightsInstallationIdentityMatch(expected, {
        ...expected,
        digestHex: "A".repeat(64),
      }),
    ).toThrowError("installation-identity-collision");
  });

  it("recomputes a persisted digest from the retained full identity", async () => {
    const identity = {
      digestHex: INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS[2].sha256Hex,
      installId: INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS[2].installId,
    };
    await expect(
      assertInsightsInstallationIdentityDigest(identity),
    ).resolves.toBeUndefined();
    await expect(
      assertInsightsInstallationIdentityDigest({
        ...identity,
        digestHex: "0".repeat(64),
      }),
    ).rejects.toThrow("installation-identity-collision");
  });
});
