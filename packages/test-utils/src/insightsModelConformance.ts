import type {
  BundleEventRow,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPageEventsResult,
  InsightsReportPage,
  InsightsReportPageInput,
  InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsInstallationIdentityDigest,
  assertInsightsInstallationIdentityMatch,
  compareInsightsInstallationOrderKeys,
  getInsightsInstallationOrderKey,
  INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS,
} from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import type {
  InsightsModelConformanceNamespaces,
  InsightsModelOracle,
} from "./insightsModelOracle";

export type InsightsModelConformanceHarness = InsightsModelOracle;

export const INSIGHTS_CONFORMANCE_MAX_CANDIDATE_READS = 4_096;

const bundles = {
  one: "10000000-0000-7000-8000-000000000001",
  two: "10000000-0000-7000-8000-000000000002",
  three: "10000000-0000-7000-8000-000000000003",
  four: "10000000-0000-7000-8000-000000000004",
  five: "10000000-0000-7000-8000-000000000005",
  six: "10000000-0000-7000-8000-000000000006",
  current: "10000000-0000-7000-8000-000000000007",
  lower: "10000000-0000-7000-8000-000000000008",
  target: "10000000-0000-7000-8000-000000000009",
  tie: "10000000-0000-7000-8000-00000000000a",
} as const;

export const insightsModelConformanceEvents: readonly BundleEventRow[] = [
  {
    id: "00000000-0000-7000-8000-000000000001",
    type: "UPDATE_APPLIED",
    install_id: "install-a",
    user_id: "old-user",
    username: "Old Alias",
    from_bundle_id: bundles.one,
    from_release_id: null,
    to_bundle_id: bundles.two,
    to_release_id: null,
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "a",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 100,
  },
  {
    id: "00000000-0000-7000-8000-000000000002",
    type: "RELEASE_ADOPTED",
    install_id: "install-b",
    user_id: "user-b",
    username: "Second Alias",
    from_bundle_id: bundles.one,
    from_release_id: null,
    to_bundle_id: bundles.three,
    to_release_id: null,
    platform: "android",
    app_version: "1.0.0",
    channel: "production",
    cohort: "b",
    update_strategy: "fingerprint",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 200,
  },
  {
    id: "00000000-0000-7000-8000-000000000003",
    type: "RECOVERED",
    install_id: "install-a",
    user_id: "old-user",
    username: "Old Alias",
    from_bundle_id: bundles.two,
    from_release_id: null,
    to_bundle_id: bundles.one,
    to_release_id: null,
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "a",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 300,
  },
  {
    id: "00000000-0000-7000-8000-000000000004",
    type: "UNCHANGED",
    install_id: "install-a",
    user_id: "current-user",
    username: "Current Alias",
    from_bundle_id: null,
    from_release_id: null,
    to_bundle_id: bundles.two,
    to_release_id: null,
    platform: "ios",
    app_version: "1.0.1",
    channel: "production",
    cohort: "new",
    update_strategy: null,
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 400,
  },
];

const adversarialBundleMovementEvents: readonly BundleEventRow[] = [
  {
    ...insightsModelConformanceEvents[0]!,
    id: "00000000-0000-7000-8000-00000000000a",
    type: "UPDATE_APPLIED",
    install_id: "install-b",
    from_bundle_id: bundles.two,
    to_bundle_id: bundles.four,
    update_strategy: "appVersion",
    received_at_ms: 250,
  },
  {
    ...insightsModelConformanceEvents[2]!,
    id: "00000000-0000-7000-8000-00000000000b",
    type: "RECOVERED",
    install_id: "install-b",
    from_bundle_id: bundles.four,
    to_bundle_id: bundles.two,
    update_strategy: "appVersion",
    received_at_ms: 225,
  },
];

const outOfOrderLatestEvents: readonly BundleEventRow[] = [
  {
    ...insightsModelConformanceEvents[3]!,
    id: "00000000-0000-7000-8000-000000000010",
    user_id: "tie-user",
    username: "Tie Alias",
    to_bundle_id: bundles.tie,
  },
  {
    ...insightsModelConformanceEvents[3]!,
    id: "00000000-0000-7000-8000-000000000011",
    user_id: "late-lower-user",
    username: "Late Lower Alias",
    to_bundle_id: bundles.lower,
    received_at_ms: 250,
  },
];

const appendFixtures = async (
  harness: InsightsModelConformanceHarness,
): Promise<void> => {
  for (const event of insightsModelConformanceEvents) {
    await harness.model.append(structuredClone(event));
  }
};

const runBoundedJobStep = async (
  harness: InsightsModelConformanceHarness,
  jobId: string,
  input: { readonly maxItems: number; readonly maxRequests: number },
) => {
  const result = await harness.runJobStep(jobId, input);
  expect(Number.isSafeInteger(result.usage.items)).toBe(true);
  expect(result.usage.items).toBeGreaterThanOrEqual(0);
  expect(result.usage.items).toBeLessThanOrEqual(input.maxItems);
  expect(Number.isSafeInteger(result.usage.requests)).toBe(true);
  expect(result.usage.requests).toBeGreaterThanOrEqual(0);
  expect(result.usage.requests).toBeLessThanOrEqual(input.maxRequests);
  if (result.usage.bytes !== undefined) {
    expect(Number.isSafeInteger(result.usage.bytes)).toBe(true);
    expect(result.usage.bytes).toBeGreaterThanOrEqual(0);
  }
  return result;
};

const runBoundedOtherNamespaceJobStep = async (
  harness: InsightsModelConformanceHarness,
  jobId: string,
  input: { readonly maxItems: number; readonly maxRequests: number },
) => {
  const result = await harness.runOtherNamespaceJobStep(jobId, input);
  expect(Number.isSafeInteger(result.usage.items)).toBe(true);
  expect(result.usage.items).toBeGreaterThanOrEqual(0);
  expect(result.usage.items).toBeLessThanOrEqual(input.maxItems);
  expect(Number.isSafeInteger(result.usage.requests)).toBe(true);
  expect(result.usage.requests).toBeGreaterThanOrEqual(0);
  expect(result.usage.requests).toBeLessThanOrEqual(input.maxRequests);
  if (result.usage.bytes !== undefined) {
    expect(Number.isSafeInteger(result.usage.bytes)).toBe(true);
    expect(result.usage.bytes).toBeGreaterThanOrEqual(0);
  }
  return result;
};

const assertCandidateReadBudget = (
  harness: InsightsModelConformanceHarness,
  declared: number,
): void => {
  expect(Number.isSafeInteger(declared)).toBe(true);
  expect(declared).toBeGreaterThanOrEqual(1);
  expect(declared).toBeLessThanOrEqual(
    INSIGHTS_CONFORMANCE_MAX_CANDIDATE_READS,
  );
  expect(harness.getLastStorageReadCount()).toBeLessThanOrEqual(declared);
};

const assertEventReadBudget = (
  harness: InsightsModelConformanceHarness,
  input: InsightsPageEventsInput,
): void =>
  assertCandidateReadBudget(
    harness,
    harness.getPageEventsCandidateReadBudget(input),
  );

const assertInstallationReadBudget = (
  harness: InsightsModelConformanceHarness,
  input: InsightsInstallationPageInput,
): void =>
  assertCandidateReadBudget(
    harness,
    harness.getPageInstallationsCandidateReadBudget(input),
  );

const assertReportReadBudget = (
  harness: InsightsModelConformanceHarness,
  input: InsightsReportPageInput,
): void =>
  assertCandidateReadBudget(
    harness,
    harness.getPageReportCandidateReadBudget(input),
  );

const completeJob = async (
  harness: InsightsModelConformanceHarness,
  jobId: string,
): Promise<string> => {
  for (let step = 0; step < 32; step += 1) {
    const result = await runBoundedJobStep(harness, jobId, {
      maxItems: 256,
      maxRequests: 128,
    });
    if (result.state === "complete") return result.publicationId;
    if (result.state === "failed") throw new Error("job failed");
  }
  throw new Error("job did not complete within 32 bounded steps");
};

const completeOtherNamespaceJob = async (
  harness: InsightsModelConformanceHarness,
  jobId: string,
): Promise<string> => {
  for (let step = 0; step < 32; step += 1) {
    const result = await runBoundedOtherNamespaceJobStep(harness, jobId, {
      maxItems: 256,
      maxRequests: 128,
    });
    if (result.state === "complete") return result.publicationId;
    if (result.state === "failed") throw new Error("job failed");
  }
  throw new Error("job did not complete within 32 bounded steps");
};

const readyPage = <
  TResult extends InsightsPageEventsResult | InsightsInstallationPage,
>(
  result: TResult,
): Extract<TResult, { readonly state: "ready" }> => {
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error("expected ready page");
  return result as Extract<TResult, { readonly state: "ready" }>;
};

const drainInstallationIds = async (
  harness: InsightsModelConformanceHarness,
  input: InsightsInstallationPageInput,
): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 512; pageIndex += 1) {
    const request =
      cursor === undefined ? input : ({ ...input, cursor } as typeof input);
    const page = readyPage(await harness.model.pageInstallations(request));
    assertInstallationReadBudget(harness, request);
    for (const row of page.data.data) {
      expect(ids).not.toContain(row.install_id);
      ids.push(row.install_id);
    }
    if (page.data.nextCursor === null) return ids;
    cursor = page.data.nextCursor;
  }
  throw new Error("installation pages did not drain within 512 pages");
};

const digestHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const preparingReport = (
  result: InsightsReportResult,
): Extract<InsightsReportResult, { readonly state: "preparing" }> => {
  expect(result.state).toBe("preparing");
  if (result.state !== "preparing")
    throw new Error("expected preparing report");
  return result;
};

const readyReport = (
  result: InsightsReportResult,
): Extract<InsightsReportResult, { readonly state: "ready" }> => {
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error("expected ready report");
  return result;
};

const series = (
  firstBucketMs: number,
  bucketCount: number,
  bucketSizeMs: number,
  values: ReadonlyMap<number, number>,
) =>
  Array.from({ length: bucketCount }, (_, index) => {
    const bucketStartMs = firstBucketMs + index * bucketSizeMs;
    return { bucketStartMs, value: values.get(bucketStartMs) ?? 0 };
  });

const drainReportPages = async (
  harness: InsightsModelConformanceHarness,
  input: InsightsReportPageInput,
): Promise<readonly unknown[]> => {
  const rows: unknown[] = [];
  const seenRows = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = input.cursor;
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const request = {
      ...input,
      ...(cursor === undefined ? {} : { cursor }),
    } as InsightsReportPageInput;
    const result = await harness.model.pageReport(request);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected report page");
    total ??= result.data.total.value;
    expect(result.data.total.value).toBe(total);
    expect(result.data.total).toMatchObject({
      state: "exact",
      sourceGeneration:
        result.data.consistency.cutoff.publication.sourceGeneration,
    });
    expect(result.data.hasNext).toBe(result.data.nextCursor !== null);
    assertReportReadBudget(harness, request);
    for (const row of result.data.data) {
      const identity = JSON.stringify(row);
      expect(seenRows.has(identity)).toBe(false);
      seenRows.add(identity);
      rows.push(row);
    }
    if (result.data.nextCursor === null) {
      expect(rows).toHaveLength(total);
      return rows;
    }
    expect(seenCursors.has(result.data.nextCursor)).toBe(false);
    seenCursors.add(result.data.nextCursor);
    cursor = result.data.nextCursor;
  }
  throw new Error("report pages did not drain within 1,000 pages");
};

/**
 * Runs the provider-neutral five-method contract. The factory must use the
 * supplied durable namespace pair and return fresh stores for every call.
 */
const CONFORMANCE_NAMESPACES = {
  insightsDatabaseNamespace: "00000000-0000-7000-8000-00000000c001",
  otherInsightsDatabaseNamespace: "00000000-0000-7000-8000-00000000c002",
} as const satisfies InsightsModelConformanceNamespaces;

export const registerInsightsModelTests = (
  createHarness: (
    namespaces: InsightsModelConformanceNamespaces,
  ) =>
    | InsightsModelConformanceHarness
    | Promise<InsightsModelConformanceHarness>,
): void => {
  describe("Insights model conformance", () => {
    it("validates append before mutation and preserves every public event type", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await expect(
        harness.model.append({
          ...insightsModelConformanceEvents[0]!,
          id: "not-a-uuidv7",
        }),
      ).rejects.toThrow();
      await expect(
        harness.model.append({
          id: "00000000-0000-7000-8000-000000000099",
        } as BundleEventRow),
      ).rejects.toThrow();
      const oversized = {
        ...insightsModelConformanceEvents[0]!,
        id: "00000000-0000-7000-8000-000000000098",
        extension: Array.from({ length: 21 }, () => "x".repeat(1000)),
      } as BundleEventRow & { readonly extension: readonly string[] };
      await expect(harness.model.append(oversized)).rejects.toThrow();
      await expect(
        harness.model.append({
          ...insightsModelConformanceEvents[0]!,
          id: "00000000-0000-7000-8000-000000000096",
          install_id: "nul\0identity",
        }),
      ).rejects.toThrow();

      const empty = readyPage(
        await harness.model.pageEvents({
          selector: { kind: "all" },
          beforeReceivedAtMs: 1_000,
          limit: 10,
        }),
      );
      expect(empty.data.data).toEqual([]);

      const providerExtension = { trace: "original" };
      const extendedEvent = {
        ...insightsModelConformanceEvents[0]!,
        id: "00000000-0000-7000-8000-000000000097",
        received_at_ms: 450,
        providerExtension,
      } as BundleEventRow & {
        readonly providerExtension: { trace: string };
      };
      await harness.model.append(extendedEvent);
      providerExtension.trace = "caller-mutated";
      const duplicateEvent = {
        ...extendedEvent,
        user_id: "duplicate-mutation",
        providerExtension: { trace: "duplicate" },
      } as BundleEventRow & {
        readonly providerExtension: { readonly trace: string };
      };
      await expect(harness.model.append(duplicateEvent)).rejects.toThrow();

      await appendFixtures(harness);
      const page = readyPage(
        await harness.model.pageEvents({
          selector: { kind: "all" },
          beforeReceivedAtMs: 1_000,
          limit: 10,
        }),
      );
      expect(page.data.data).toHaveLength(5);
      expect(
        page.data.data.find((event) => event.id === extendedEvent.id),
      ).toMatchObject({
        user_id: extendedEvent.user_id,
        providerExtension: { trace: "original" },
      });
      expect(page.data.data.map(({ type }) => type)).toEqual([
        "UPDATE_APPLIED",
        "UNCHANGED",
        "RECOVERED",
        "RELEASE_ADOPTED",
        "UPDATE_APPLIED",
      ]);
    });

    it("bounds event reads and binds cursors to namespace, scope, and cutoff", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      const allInput = {
        selector: { kind: "all" as const },
        beforeReceivedAtMs: 1_000,
        limit: 1,
      };
      const first = readyPage(await harness.model.pageEvents(allInput));
      expect(first.data.data).toHaveLength(1);
      expect(first.data.nextCursor).not.toBeNull();
      assertEventReadBudget(harness, allInput);

      await harness.model.append({
        ...insightsModelConformanceEvents[1]!,
        id: "00000000-0000-7000-8000-000000000006",
        install_id: "install-c",
        received_at_ms: 350,
      });

      const secondInput = { ...allInput, cursor: first.data.nextCursor! };
      const second = readyPage(await harness.model.pageEvents(secondInput));
      assertEventReadBudget(harness, secondInput);
      expect(second.data.data).toHaveLength(1);
      expect(second.data.data[0]!.id).toBe(
        "00000000-0000-7000-8000-000000000006",
      );
      const drainedIds = [first.data.data[0]!.id, second.data.data[0]!.id];
      let drainCursor = second.data.nextCursor;
      while (drainCursor !== null) {
        const request = { ...allInput, cursor: drainCursor };
        const page = readyPage(await harness.model.pageEvents(request));
        assertEventReadBudget(harness, request);
        for (const event of page.data.data) {
          expect(drainedIds).not.toContain(event.id);
          drainedIds.push(event.id);
        }
        drainCursor = page.data.nextCursor;
      }
      expect(drainedIds).toEqual([
        "00000000-0000-7000-8000-000000000004",
        "00000000-0000-7000-8000-000000000006",
        "00000000-0000-7000-8000-000000000003",
        "00000000-0000-7000-8000-000000000002",
        "00000000-0000-7000-8000-000000000001",
      ]);
      for (const event of adversarialBundleMovementEvents) {
        await harness.model.append(event);
      }
      const readsBeforeWrongEventCursor = harness.getLastStorageReadCount();
      await expect(
        harness.model.pageEvents({
          ...allInput,
          beforeReceivedAtMs: 999,
          cursor: first.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount()).toBe(
        readsBeforeWrongEventCursor,
      );
      await expect(
        harness.model.pageEvents({
          selector: { kind: "installationId", installId: "install-a" },
          beforeReceivedAtMs: 1_000,
          limit: 1,
          cursor: first.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount()).toBe(
        readsBeforeWrongEventCursor,
      );
      await expect(
        harness.otherNamespaceModel.pageEvents({
          ...allInput,
          cursor: first.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount("other")).toBe(0);

      const installationInput = {
        selector: { kind: "installationId" as const, installId: "install-a" },
        beforeReceivedAtMs: 1_000,
        limit: 2,
      };
      const installation = readyPage(
        await harness.model.pageEvents(installationInput),
      );
      expect(installation.data.data.map(({ id }) => id)).toEqual([
        "00000000-0000-7000-8000-000000000003",
        "00000000-0000-7000-8000-000000000001",
      ]);
      assertEventReadBudget(harness, installationInput);
      const bundleInput = {
        selector: { kind: "bundleId" as const, bundleId: bundles.two },
        beforeReceivedAtMs: 1_000,
        limit: 2,
      };
      const bundle = readyPage(await harness.model.pageEvents(bundleInput));
      expect(bundle.data.data.map(({ id }) => id)).toEqual([
        "00000000-0000-7000-8000-000000000003",
        "00000000-0000-7000-8000-000000000001",
      ]);
      assertEventReadBudget(harness, bundleInput);

      const inclusiveSinceInput = {
        selector: { kind: "all" as const },
        sinceReceivedAtMs: 100,
        beforeReceivedAtMs: 101,
        limit: 1,
      };
      const inclusiveSince = readyPage(
        await harness.model.pageEvents(inclusiveSinceInput),
      );
      assertEventReadBudget(harness, inclusiveSinceInput);
      expect(inclusiveSince.data.data.map(({ id }) => id)).toEqual([
        "00000000-0000-7000-8000-000000000001",
      ]);
    });

    it("pages live all and exact-installation projections without overread", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      const allInput = { kind: "all" as const, limit: 1 };
      const all = readyPage(await harness.model.pageInstallations(allInput));
      expect(all.data.data).toHaveLength(1);
      expect(all.data.nextCursor).not.toBeNull();
      assertInstallationReadBudget(harness, allInput);
      const nextInput = {
        kind: "all" as const,
        limit: 1,
        cursor: all.data.nextCursor!,
      };
      const next = readyPage(await harness.model.pageInstallations(nextInput));
      assertInstallationReadBudget(harness, nextInput);
      expect(next.data.data).toHaveLength(1);
      expect(next.data.data[0]!.install_id).not.toBe(
        all.data.data[0]!.install_id,
      );

      const exactInput = {
        kind: "installationId" as const,
        installId: "install-a",
        limit: 10,
      };
      const exact = readyPage(
        await harness.model.pageInstallations(exactInput),
      );
      expect(exact.data.data).toHaveLength(1);
      expect(exact.data.data[0]).toMatchObject({
        install_id: "install-a",
        user_id: "current-user",
        username: "Current Alias",
        received_at_ms: 400,
      });
      expect(exact.data.nextCursor).toBeNull();
      assertInstallationReadBudget(harness, exactInput);
      await expect(
        harness.model.pageInstallations({
          kind: "installationId",
          installId: "install-a",
          limit: 1,
          cursor: JSON.stringify([
            1,
            "primary",
            "installations-live",
            "installation:install-a",
            4,
            0,
          ]),
        } as never),
      ).rejects.toThrow();
    });

    it("drains native hash-ordered installation identities and preserves selector string semantics", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      const keyedVectors = await Promise.all(
        INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS.map(async (vector, index) => {
          expect(JSON.stringify(vector.installId)).toBe(vector.json);
          const key = await getInsightsInstallationOrderKey(vector.installId);
          expect(digestHex(key)).toBe(vector.sha256Hex);
          await expect(
            assertInsightsInstallationIdentityDigest({
              digestHex: vector.sha256Hex,
              installId: vector.installId,
            }),
          ).resolves.toBeUndefined();
          await harness.model.append({
            ...insightsModelConformanceEvents[3]!,
            id: `00000000-0000-7000-8000-${(32 + index)
              .toString(16)
              .padStart(12, "0")}`,
            install_id: vector.installId,
            user_id: "ExactCase",
            username: "literal%_İ marker",
            received_at_ms: 500 + index,
          });
          return { installId: vector.installId, key };
        }),
      );
      keyedVectors.sort((left, right) =>
        compareInsightsInstallationOrderKeys(left.key, right.key),
      );
      const expectedOrder = keyedVectors.map(({ installId }) => installId);
      const rawStringOrder = INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS.map(
        ({ installId }) => installId,
      ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      expect(expectedOrder).not.toEqual(rawStringOrder);

      expect(
        await drainInstallationIds(harness, { kind: "all", limit: 1 }),
      ).toEqual(expectedOrder);

      await harness.model.append({
        ...insightsModelConformanceEvents[3]!,
        id: "00000000-0000-7000-8000-000000000040",
        install_id: "wildcard-distractor",
        user_id: "OtherCase",
        username: "xİ",
        received_at_ms: 2_000,
      });
      harness.setCurrentTimeMs(3_000);

      const literalPreparing = await harness.model.pageInstallations({
        kind: "contains",
        query: "%_İ",
        limit: 1,
      });
      expect(literalPreparing.state).toBe("preparing");
      if (literalPreparing.state !== "preparing") {
        throw new Error("expected literal contains preparation");
      }
      const lowercaseExpansion = await harness.model.pageInstallations({
        kind: "contains",
        query: "%_i\u0307",
        limit: 1,
      });
      expect(lowercaseExpansion).toMatchObject({
        state: "preparing",
        job: { id: literalPreparing.job.id },
      });
      await completeJob(harness, literalPreparing.job.id);
      expect(
        await drainInstallationIds(harness, {
          kind: "contains",
          query: "%_İ",
          limit: 1,
        }),
      ).toEqual(expectedOrder);

      const exactUserPreparing = await harness.model.pageInstallations({
        kind: "userId",
        userId: "ExactCase",
        limit: 1,
      });
      expect(exactUserPreparing.state).toBe("preparing");
      if (exactUserPreparing.state !== "preparing") {
        throw new Error("expected exact-user preparation");
      }
      await completeJob(harness, exactUserPreparing.job.id);
      expect(
        await drainInstallationIds(harness, {
          kind: "userId",
          userId: "ExactCase",
          limit: 1,
        }),
      ).toEqual(expectedOrder);

      const wrongCasePreparing = await harness.model.pageInstallations({
        kind: "userId",
        userId: "exactcase",
        limit: 1,
      });
      expect(wrongCasePreparing.state).toBe("preparing");
      if (wrongCasePreparing.state !== "preparing") {
        throw new Error("expected wrong-case preparation");
      }
      await completeJob(harness, wrongCasePreparing.job.id);
      expect(
        await drainInstallationIds(harness, {
          kind: "userId",
          userId: "exactcase",
          limit: 1,
        }),
      ).toEqual([]);

      for (const query of ["é", "e\u0301"] as const) {
        const preparing = await harness.model.pageInstallations({
          kind: "contains",
          query,
          limit: 1,
        });
        expect(preparing.state).toBe("preparing");
        if (preparing.state !== "preparing") {
          throw new Error("expected normalization-sensitive preparation");
        }
        await completeJob(harness, preparing.job.id);
        expect(
          await drainInstallationIds(harness, {
            kind: "contains",
            query,
            limit: 1,
          }),
        ).toEqual([query]);
      }

      const identity = {
        digestHex: INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS[0]!.sha256Hex,
        installId: INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS[0]!.installId,
      };
      expect(() =>
        assertInsightsInstallationIdentityMatch(identity, identity),
      ).not.toThrow();
      expect(() =>
        assertInsightsInstallationIdentityMatch(identity, {
          ...identity,
          installId: "collision-control",
        }),
      ).toThrow("installation-identity-collision");
      await expect(
        assertInsightsInstallationIdentityDigest({
          ...identity,
          installId: "collision-control",
        }),
      ).rejects.toThrow("installation-identity-collision");
    });

    it("selects latest metadata by event tuple instead of append order", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      for (const event of outOfOrderLatestEvents) {
        await harness.model.append(event);
      }
      harness.setCurrentTimeMs(1_000);

      const exact = readyPage(
        await harness.model.pageInstallations({
          kind: "installationId",
          installId: "install-a",
          limit: 1,
        }),
      );
      expect(exact.data.data).toEqual([
        expect.objectContaining({
          id: "00000000-0000-7000-8000-000000000010",
          user_id: "tie-user",
          to_bundle_id: bundles.tie,
          received_at_ms: 400,
        }),
      ]);
      const all = readyPage(
        await harness.model.pageInstallations({ kind: "all", limit: 10 }),
      );
      expect(
        all.data.data.find((row) => row.install_id === "install-a"),
      ).toMatchObject({
        id: "00000000-0000-7000-8000-000000000010",
        user_id: "tie-user",
        received_at_ms: 400,
      });

      const userPreparing = await harness.model.pageInstallations({
        kind: "userId",
        userId: "old-user",
        limit: 10,
      });
      expect(userPreparing.state).toBe("preparing");
      if (userPreparing.state !== "preparing") {
        throw new Error("expected user preparation");
      }
      await completeJob(harness, userPreparing.job.id);
      const user = readyPage(
        await harness.model.pageInstallations({
          kind: "userId",
          userId: "old-user",
          limit: 10,
        }),
      );
      expect(user.data.data[0]).toMatchObject({
        id: "00000000-0000-7000-8000-000000000010",
        user_id: "tie-user",
        received_at_ms: 400,
      });

      const containsPreparing = await harness.model.pageInstallations({
        kind: "contains",
        query: "old alias",
        limit: 10,
      });
      expect(containsPreparing.state).toBe("preparing");
      if (containsPreparing.state !== "preparing") {
        throw new Error("expected contains preparation");
      }
      await completeJob(harness, containsPreparing.job.id);
      const contains = readyPage(
        await harness.model.pageInstallations({
          kind: "contains",
          query: "OLD ALIAS",
          limit: 10,
        }),
      );
      expect(contains.data.data[0]).toMatchObject({
        id: "00000000-0000-7000-8000-000000000010",
        user_id: "tie-user",
        received_at_ms: 400,
      });
    });

    it("publishes exact user and contains snapshots with durable job reuse", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      harness.setCurrentTimeMs(1_000);
      const userInput = {
        kind: "userId" as const,
        userId: "old-user",
        limit: 10,
      };
      const first = await harness.model.pageInstallations(userInput);
      expect(first.state).toBe("preparing");
      if (first.state !== "preparing") throw new Error("expected preparation");
      const repeated = await harness.model.pageInstallations(userInput);
      expect(repeated).toMatchObject({
        state: "preparing",
        job: { id: first.job.id },
      });
      expect(harness.publicationStateForJob(first.job.id)).toBe("absent");
      await harness.model.append({
        ...insightsModelConformanceEvents[3]!,
        id: "00000000-0000-7000-8000-000000000005",
        user_id: "after-reservation",
        received_at_ms: 500,
      });
      const afterConcurrentAppend =
        await harness.model.pageInstallations(userInput);
      expect(afterConcurrentAppend).toMatchObject({
        state: "preparing",
        versions: { sourceGeneration: first.versions.sourceGeneration },
        job: { id: first.job.id },
      });
      const publicationId = await completeJob(harness, first.job.id);
      expect(harness.publicationStateForJob(first.job.id)).toBe("complete");

      const ready = readyPage(await harness.model.pageInstallations(userInput));
      expect(ready.data.data).toHaveLength(1);
      expect(ready.data.data[0]).toMatchObject({
        install_id: "install-a",
        user_id: "current-user",
        received_at_ms: 400,
      });
      expect(ready.data.total).toEqual({
        state: "exact",
        value: 1,
        sourceGeneration:
          ready.data.consistency.cutoff.publication.sourceGeneration,
      });

      await harness.model.append({
        ...insightsModelConformanceEvents[3]!,
        id: "00000000-0000-7000-8000-000000000007",
        user_id: "newest-user",
        received_at_ms: 600,
      });
      const pinned = readyPage(
        await harness.model.pageInstallations({
          ...userInput,
          publicationId,
        }),
      );
      expect(pinned.data.data[0]).toMatchObject({
        user_id: "current-user",
        received_at_ms: 400,
      });
      await expect(
        harness.model.pageInstallations({
          kind: "contains",
          query: "install",
          publicationId,
          limit: 1,
        }),
      ).resolves.toEqual({ state: "expired", publicationId });
      await expect(
        harness.otherNamespaceModel.pageInstallations({
          ...userInput,
          publicationId,
        }),
      ).resolves.toEqual({ state: "expired", publicationId });
      const expired = await harness.model.pageInstallations({
        ...userInput,
        publicationId,
        minAsOfMs: 1_001,
      });
      expect(expired).toEqual({ state: "expired", publicationId });
      harness.setCurrentTimeMs(1_001);
      const stale = await harness.model.pageInstallations({
        ...userInput,
        minAsOfMs: 1_001,
      });
      expect(stale.state).toBe("stale");
      if (stale.state !== "stale") throw new Error("expected stale snapshot");
      expect(stale.data.data[0]!.received_at_ms).toBe(400);
      const staleAgain = await harness.model.pageInstallations({
        ...userInput,
        minAsOfMs: 1_001,
      });
      expect(staleAgain).toMatchObject({
        state: "stale",
        refresh: { id: stale.refresh.id },
      });

      const containsInput = {
        kind: "contains" as const,
        query: "install",
        limit: 1,
      };
      const containsPreparing =
        await harness.model.pageInstallations(containsInput);
      expect(containsPreparing.state).toBe("preparing");
      if (containsPreparing.state !== "preparing") {
        throw new Error("expected contains preparation");
      }
      const containsCaseVariant = await harness.model.pageInstallations({
        ...containsInput,
        query: "INSTALL",
      });
      expect(containsCaseVariant).toMatchObject({
        state: "preparing",
        job: { id: containsPreparing.job.id },
      });
      const containsPartial = await runBoundedJobStep(
        harness,
        containsPreparing.job.id,
        { maxItems: 1, maxRequests: 1 },
      );
      expect(["running", "idle"]).toContain(containsPartial.state);
      if (
        containsPartial.state !== "running" &&
        containsPartial.state !== "idle"
      ) {
        throw new Error("expected a partial contains step");
      }
      expect(containsPartial.jobId).toBe(containsPreparing.job.id);
      expect(harness.publicationStateForJob(containsPreparing.job.id)).toBe(
        "absent",
      );
      await harness.model.append({
        ...insightsModelConformanceEvents[3]!,
        id: "00000000-0000-7000-8000-00000000000c",
        install_id: "install-c",
        received_at_ms: 700,
      });
      const containsPublicationId = await completeJob(
        harness,
        containsPreparing.job.id,
      );
      expect(harness.publicationStateForJob(containsPreparing.job.id)).toBe(
        "complete",
      );
      const contains = readyPage(
        await harness.model.pageInstallations(containsInput),
      );
      expect(contains.data.data).toHaveLength(1);
      expect(contains.data.nextCursor).not.toBeNull();
      assertInstallationReadBudget(harness, containsInput);
      const publishedSourceGeneration = contains.versions.sourceGeneration;
      const publishedCutoff = contains.data.consistency.cutoff.publication;
      const directPin = await harness.model.pageInstallations({
        ...containsInput,
        publicationId: containsPublicationId,
        limit: 10,
      });
      expect(directPin.state).toBe("ready");
      const continuation = await harness.model.pageInstallations({
        ...containsInput,
        cursor: contains.data.nextCursor!,
      });
      expect(["ready", "stale", "expired", "failed"]).toContain(
        continuation.state,
      );
      expect(continuation.state).not.toBe("preparing");
      if (continuation.state === "ready" || continuation.state === "stale") {
        expect(
          continuation.data.data.some((row) => row.install_id === "install-c"),
        ).toBe(false);
        expect(continuation.data.total).toMatchObject({
          state: "exact",
          value: 2,
        });
        expect(continuation.versions.sourceGeneration).toBe(
          publishedSourceGeneration,
        );
        expect(continuation.data.consistency.cutoff.publication).toEqual(
          publishedCutoff,
        );
      }
      const readsBeforeWrongCursor = harness.getLastStorageReadCount();
      await expect(
        harness.model.pageInstallations({
          ...userInput,
          cursor: contains.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount()).toBe(readsBeforeWrongCursor);
      await expect(
        harness.model.pageInstallations({
          ...containsInput,
          publicationId: "publication-wrong",
          cursor: contains.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount()).toBe(readsBeforeWrongCursor);
      await expect(
        harness.otherNamespaceModel.pageInstallations({
          ...containsInput,
          cursor: contains.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount("other")).toBe(0);
      await harness.expirePublication(containsPublicationId);
      await expect(
        harness.model.pageInstallations({
          ...containsInput,
          cursor: contains.data.nextCursor!,
        }),
      ).resolves.toEqual({
        state: "expired",
        publicationId: containsPublicationId,
      });
    });

    it("publishes every report kind and every immutable report section", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      await harness.model.append({
        ...insightsModelConformanceEvents[0]!,
        id: "00000000-0000-7000-8000-000000000008",
        received_at_ms: 150,
      });
      await harness.model.append({
        ...insightsModelConformanceEvents[3]!,
        id: "00000000-0000-7000-8000-000000000009",
        install_id: "install-b",
        user_id: "user-b",
        username: "Second Alias",
        to_bundle_id: bundles.three,
        platform: "android",
        cohort: "b",
        received_at_ms: 200_000_000,
      });
      for (const event of adversarialBundleMovementEvents) {
        await harness.model.append(event);
      }
      harness.setCurrentTimeMs(200_000_001);
      const queries = [
        {
          kind: "bundleSummaries" as const,
          bundleIds: [bundles.two, bundles.six, bundles.one, bundles.two],
          window: "all" as const,
        },
        {
          kind: "bundleDetail" as const,
          bundleId: bundles.two,
          window: "all" as const,
        },
        { kind: "installationOverview" as const },
        { kind: "activeOverview" as const, window: "24h" as const },
      ];
      const publications = new Map<string, string>();
      for (const query of queries) {
        const first = preparingReport(await harness.model.getReport({ query }));
        const repeated = preparingReport(
          await harness.model.getReport({ query }),
        );
        expect(repeated.job.id).toBe(first.job.id);
        if (query.kind === "bundleSummaries") {
          const canonicalPoll = preparingReport(
            await harness.model.getReport({
              query: {
                ...query,
                bundleIds: [bundles.one, bundles.two, bundles.six],
              },
            }),
          );
          expect(canonicalPoll.job.id).toBe(first.job.id);
          const reportPartial = await runBoundedJobStep(harness, first.job.id, {
            maxItems: 1,
            maxRequests: 1,
          });
          expect(["running", "idle"]).toContain(reportPartial.state);
          if (
            reportPartial.state !== "running" &&
            reportPartial.state !== "idle"
          ) {
            throw new Error("expected a partial report step");
          }
          expect(reportPartial.jobId).toBe(first.job.id);
          expect(harness.publicationStateForJob(first.job.id)).toBe("absent");
          await harness.model.append({
            ...insightsModelConformanceEvents[0]!,
            id: "00000000-0000-7000-8000-000000000019",
            type: "UPDATE_APPLIED",
            from_bundle_id: bundles.five,
            to_bundle_id: bundles.six,
            update_strategy: "appVersion",
            received_at_ms: 50,
          });
        }
        const publicationId = await completeJob(harness, first.job.id);
        expect(harness.publicationStateForJob(first.job.id)).toBe("complete");
        const ready = readyReport(await harness.model.getReport({ query }));
        expect(ready.data.kind).toBe(query.kind);
        expect(ready.data.id).toBe(publicationId);
        expect(ready.data.sourceGeneration).toBe(
          ready.versions.sourceGeneration,
        );
        if (ready.data.kind === "bundleSummaries") {
          expect(ready.data.summary).toEqual([
            { bundleId: bundles.one, installed: 0, recovered: 0 },
            { bundleId: bundles.two, installed: 1, recovered: 1 },
            { bundleId: bundles.six, installed: 0, recovered: 0 },
          ]);
        } else if (ready.data.kind === "bundleDetail") {
          expect(ready.data.summary).toEqual({ installed: 1, recovered: 1 });
        } else if (ready.data.kind === "installationOverview") {
          expect(ready.data.summary.trackedInstallations).toBe(2);
        } else {
          expect(ready.data.summary.activeInstallations).toBe(1);
        }
        publications.set(query.kind, publicationId);
      }

      const activeUserQuery = {
        kind: "activeOverview" as const,
        window: "24h" as const,
        userId: "user-b",
      };
      const activeUserPreparing = preparingReport(
        await harness.model.getReport({ query: activeUserQuery }),
      );
      const activeUserPublication = await completeJob(
        harness,
        activeUserPreparing.job.id,
      );
      const activeUser = readyReport(
        await harness.model.getReport({ query: activeUserQuery }),
      );
      expect(activeUser.data).toMatchObject({
        kind: "activeOverview",
        summary: { activeInstallations: 1 },
      });
      harness.setCurrentTimeMs(200_000_002);
      const staleActiveUser = await harness.model.getReport({
        query: activeUserQuery,
        minAsOfMs: 200_000_002,
      });
      expect(staleActiveUser).toMatchObject({
        state: "stale",
        data: { id: activeUserPublication },
        refresh: { id: expect.any(String) },
      });

      const sections = [
        {
          publicationId: publications.get("bundleDetail")!,
          section: "movementSeries" as const,
          metric: "installed" as const,
          expected: series(0, 3, 86_400_000, new Map([[0, 1]])),
        },
        {
          publicationId: publications.get("bundleDetail")!,
          section: "movementCohorts" as const,
          metric: "installed" as const,
          expected: [{ cohort: "a", value: 1 }],
        },
        {
          publicationId: publications.get("bundleDetail")!,
          section: "movementSeries" as const,
          metric: "recovered" as const,
          expected: series(0, 3, 86_400_000, new Map([[0, 1]])),
        },
        {
          publicationId: publications.get("bundleDetail")!,
          section: "movementCohorts" as const,
          metric: "recovered" as const,
          expected: [{ cohort: "a", value: 1 }],
        },
        {
          publicationId: publications.get("installationOverview")!,
          section: "bundleDistribution" as const,
          expected: [
            { bundleId: bundles.two, installations: 1 },
            { bundleId: bundles.three, installations: 1 },
          ],
        },
        {
          publicationId: activeUserPublication,
          section: "activeSeries" as const,
          expected: series(
            113_600_001,
            24,
            3_600_000,
            new Map([[196_400_001, 1]]),
          ),
        },
        {
          publicationId: activeUserPublication,
          section: "bundleDistribution" as const,
          expected: [{ bundleId: bundles.three, installations: 1 }],
        },
        {
          publicationId: activeUserPublication,
          section: "activeBundleSeries" as const,
          expected: series(
            113_600_001,
            24,
            3_600_000,
            new Map([[196_400_001, 1]]),
          ).map((row) => ({ bundleId: bundles.three, ...row })),
        },
      ];
      for (const section of sections) {
        const { expected, ...input } = section;
        const data = await drainReportPages(harness, {
          ...input,
          limit: 1,
        });
        expect(data).toEqual(expected);
      }

      const publicationId = publications.get("installationOverview")!;
      const distribution = await harness.model.pageReport({
        publicationId,
        section: "bundleDistribution",
        limit: 1,
      });
      expect(distribution.state).toBe("ready");
      if (distribution.state !== "ready") throw new Error("expected page");
      expect(distribution.data.nextCursor).not.toBeNull();
      const readsBeforeWrongReportCursor = harness.getLastStorageReadCount();
      await expect(
        harness.model.pageReport({
          publicationId: publications.get("activeOverview")!,
          section: "activeSeries",
          limit: 1,
          cursor: distribution.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount()).toBe(
        readsBeforeWrongReportCursor,
      );

      for (const event of insightsModelConformanceEvents) {
        await harness.otherNamespaceModel.append(structuredClone(event));
      }
      const otherPreparing = preparingReport(
        await harness.otherNamespaceModel.getReport({
          query: { kind: "installationOverview" },
        }),
      );
      const otherPublicationId = await completeOtherNamespaceJob(
        harness,
        otherPreparing.job.id,
      );
      const otherPage = await harness.otherNamespaceModel.pageReport({
        publicationId: otherPublicationId,
        section: "bundleDistribution",
        limit: 1,
      });
      expect(otherPage.state).toBe("ready");
      const readsBeforeCrossNamespaceCursor =
        harness.getLastStorageReadCount("other");
      await expect(
        harness.otherNamespaceModel.pageReport({
          publicationId,
          section: "bundleDistribution",
          limit: 1,
          cursor: distribution.data.nextCursor!,
        }),
      ).rejects.toThrow();
      expect(harness.getLastStorageReadCount("other")).toBe(
        readsBeforeCrossNamespaceCursor,
      );
      await expect(
        harness.model.pageReport({
          publicationId: publications.get("bundleDetail")!,
          section: "activeSeries",
          limit: 1,
        }),
      ).rejects.toThrow();
    });

    it("uses finite calendar buckets, fixed report order, and zero rows", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      const hourMs = 3_600_000;
      const dayMs = 86_400_000;
      const nowMs = 40 * dayMs;
      const movementFirstBucketMs = nowMs - 23 * hourMs;
      const activeFirstBucketMs = nowMs - dayMs;
      harness.setCurrentTimeMs(nowMs);
      const movementBase = insightsModelConformanceEvents[0]!;
      const activityBase = insightsModelConformanceEvents[3]!;
      const events: readonly BundleEventRow[] = [
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000020",
          install_id: "install-outside",
          user_id: "outside",
          to_bundle_id: bundles.target,
          cohort: "outside",
          received_at_ms: movementFirstBucketMs - 1,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000021",
          install_id: "install-edge",
          user_id: "old-user",
          to_bundle_id: bundles.target,
          cohort: "\u2028",
          received_at_ms: movementFirstBucketMs,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000022",
          install_id: "install-edge",
          user_id: "old-user",
          to_bundle_id: bundles.target,
          cohort: "e\u0301",
          received_at_ms: movementFirstBucketMs + hourMs + 100,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000023",
          install_id: "install-edge",
          user_id: "final-user",
          to_bundle_id: bundles.current,
          received_at_ms: activeFirstBucketMs + 50_000_000,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000024",
          install_id: "install-upper",
          user_id: "upper",
          to_bundle_id: bundles.target,
          cohort: "e\u0301",
          received_at_ms: nowMs - 1,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000025",
          install_id: "install-nfc",
          user_id: "nfc",
          to_bundle_id: bundles.target,
          cohort: "é",
          received_at_ms: nowMs - 2,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000026",
          install_id: "install-supplementary",
          user_id: "supplementary",
          to_bundle_id: bundles.target,
          cohort: "😀",
          received_at_ms: nowMs - 3,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000027",
          install_id: "install-tie",
          user_id: "final-user",
          to_bundle_id: bundles.tie,
          received_at_ms: activeFirstBucketMs + 10 * hourMs,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000028",
          install_id: "movement-at-upper",
          to_bundle_id: bundles.target,
          cohort: "excluded-upper",
          received_at_ms: nowMs,
        },
        {
          ...movementBase,
          id: "00000000-0000-7000-8000-000000000029",
          install_id: "movement-after-upper",
          to_bundle_id: bundles.target,
          cohort: "excluded-future",
          received_at_ms: nowMs + 1,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000030",
          install_id: "active-before-lower",
          user_id: "final-user",
          to_bundle_id: bundles.current,
          received_at_ms: activeFirstBucketMs - 1,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000031",
          install_id: "active-at-lower",
          user_id: "final-user",
          to_bundle_id: bundles.current,
          received_at_ms: activeFirstBucketMs,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000032",
          install_id: "active-at-upper",
          user_id: "final-user",
          to_bundle_id: bundles.tie,
          received_at_ms: nowMs - 1,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000033",
          install_id: "active-at-upper",
          user_id: "excluded-upper-user",
          to_bundle_id: bundles.target,
          received_at_ms: nowMs,
        },
        {
          ...activityBase,
          id: "00000000-0000-7000-8000-000000000034",
          install_id: "active-at-lower",
          user_id: "excluded-future-user",
          to_bundle_id: bundles.target,
          received_at_ms: nowMs + 1,
        },
      ];
      for (const event of events) await harness.model.append(event);

      const movementQuery = {
        kind: "bundleDetail" as const,
        bundleId: bundles.target,
        window: "24h" as const,
      };
      const movementPreparing = preparingReport(
        await harness.model.getReport({ query: movementQuery }),
      );
      const batchQuery = {
        kind: "bundleSummaries" as const,
        bundleIds: [bundles.target],
        window: "24h" as const,
      };
      const batchPreparing = preparingReport(
        await harness.model.getReport({ query: batchQuery }),
      );
      const movementPublicationId = await completeJob(
        harness,
        movementPreparing.job.id,
      );
      await completeJob(harness, batchPreparing.job.id);
      const movement = readyReport(
        await harness.model.getReport({ query: movementQuery }),
      );
      const batch = readyReport(
        await harness.model.getReport({ query: batchQuery }),
      );
      expect(movement.data).toMatchObject({
        asOfMs: nowMs,
        summary: { installed: 4, recovered: 0 },
      });
      expect(batch.data).toMatchObject({
        asOfMs: movement.data.asOfMs,
        sourceGeneration: movement.data.sourceGeneration,
        summary: [{ bundleId: bundles.target, installed: 4, recovered: 0 }],
      });
      const movementSeries = await drainReportPages(harness, {
        publicationId: movementPublicationId,
        section: "movementSeries",
        metric: "installed",
        limit: 5,
      });
      expect(movementSeries).toEqual(
        series(
          movementFirstBucketMs,
          24,
          hourMs,
          new Map([
            [movementFirstBucketMs, 1],
            [movementFirstBucketMs + hourMs, 1],
            [nowMs - hourMs, 3],
          ]),
        ),
      );
      const movementCohorts = await drainReportPages(harness, {
        publicationId: movementPublicationId,
        section: "movementCohorts",
        metric: "installed",
        limit: 2,
      });
      expect(movementCohorts).toEqual([
        { cohort: "e\u0301", value: 2 },
        { cohort: "é", value: 1 },
        { cohort: "\u2028", value: 1 },
        { cohort: "😀", value: 1 },
      ]);
      for (const [window, bucketCount] of [
        ["7d", 7],
        ["30d", 30],
      ] as const) {
        const query = { ...movementQuery, window };
        const preparing = preparingReport(
          await harness.model.getReport({ query }),
        );
        const publicationId = await completeJob(harness, preparing.job.id);
        const report = readyReport(await harness.model.getReport({ query }));
        expect(report.data).toMatchObject({
          asOfMs: nowMs,
          summary: { installed: 5, recovered: 0 },
        });
        expect(
          await drainReportPages(harness, {
            publicationId,
            section: "movementSeries",
            metric: "installed",
            limit: 4,
          }),
        ).toEqual(
          series(
            nowMs - (bucketCount - 1) * dayMs,
            bucketCount,
            dayMs,
            new Map([[nowMs - dayMs, 5]]),
          ),
        );
      }
      const allQuery = { ...movementQuery, window: "all" as const };
      const allPreparing = preparingReport(
        await harness.model.getReport({ query: allQuery }),
      );
      const allPublicationId = await completeJob(harness, allPreparing.job.id);
      expect(
        readyReport(await harness.model.getReport({ query: allQuery })).data,
      ).toMatchObject({ summary: { installed: 5, recovered: 0 } });
      expect(
        await drainReportPages(harness, {
          publicationId: allPublicationId,
          section: "movementSeries",
          metric: "installed",
          limit: 1,
        }),
      ).toEqual([
        { bucketStartMs: nowMs - dayMs, value: 5 },
        { bucketStartMs: nowMs, value: 0 },
      ]);

      const distributionQuery = {
        kind: "installationOverview" as const,
      };
      const distributionPreparing = preparingReport(
        await harness.model.getReport({ query: distributionQuery }),
      );
      const distributionPublicationId = await completeJob(
        harness,
        distributionPreparing.job.id,
      );
      expect(
        await drainReportPages(harness, {
          publicationId: distributionPublicationId,
          section: "bundleDistribution",
          limit: 1,
        }),
      ).toEqual([
        { bundleId: bundles.target, installations: 4 },
        { bundleId: bundles.current, installations: 3 },
        { bundleId: bundles.tie, installations: 2 },
      ]);

      const activeQuery = {
        kind: "activeOverview" as const,
        window: "24h" as const,
        userId: "final-user",
      };
      const activePreparing = preparingReport(
        await harness.model.getReport({ query: activeQuery }),
      );
      const activePublicationId = await completeJob(
        harness,
        activePreparing.job.id,
      );
      const active = readyReport(
        await harness.model.getReport({ query: activeQuery }),
      );
      expect(active.data).toMatchObject({
        asOfMs: nowMs,
        summary: { activeInstallations: 4 },
      });
      expect(
        await drainReportPages(harness, {
          publicationId: activePublicationId,
          section: "activeSeries",
          limit: 5,
        }),
      ).toEqual(
        series(
          activeFirstBucketMs,
          24,
          hourMs,
          new Map([
            [activeFirstBucketMs, 1],
            [activeFirstBucketMs + hourMs, 1],
            [activeFirstBucketMs + 2 * hourMs, 1],
            [activeFirstBucketMs + 10 * hourMs, 1],
            [activeFirstBucketMs + 13 * hourMs, 1],
            [nowMs - hourMs, 1],
          ]),
        ),
      );
      expect(
        await drainReportPages(harness, {
          publicationId: activePublicationId,
          section: "bundleDistribution",
          limit: 1,
        }),
      ).toEqual([
        { bundleId: bundles.current, installations: 2 },
        { bundleId: bundles.tie, installations: 2 },
      ]);
      expect(
        await drainReportPages(harness, {
          publicationId: activePublicationId,
          section: "activeBundleSeries",
          limit: 7,
        }),
      ).toEqual([
        ...series(
          activeFirstBucketMs,
          24,
          hourMs,
          new Map([
            [activeFirstBucketMs, 1],
            [activeFirstBucketMs + 13 * hourMs, 1],
          ]),
        ).map((row) => ({ bundleId: bundles.current, ...row })),
        ...series(
          activeFirstBucketMs,
          24,
          hourMs,
          new Map([
            [activeFirstBucketMs + hourMs, 1],
            [activeFirstBucketMs + 2 * hourMs, 1],
          ]),
        ).map((row) => ({ bundleId: bundles.target, ...row })),
        ...series(
          activeFirstBucketMs,
          24,
          hourMs,
          new Map([
            [activeFirstBucketMs + 10 * hourMs, 1],
            [nowMs - hourMs, 1],
          ]),
        ).map((row) => ({ bundleId: bundles.tie, ...row })),
      ]);
      expect(
        await drainReportPages(harness, {
          publicationId: activePublicationId,
          section: "activeBundleSeries",
          bundleId: bundles.target,
          limit: 6,
        }),
      ).toEqual(
        series(
          activeFirstBucketMs,
          24,
          hourMs,
          new Map([
            [activeFirstBucketMs + hourMs, 1],
            [activeFirstBucketMs + 2 * hourMs, 1],
          ]),
        ).map((row) => ({ bundleId: bundles.target, ...row })),
      );

      const emptyHarness = await createHarness(CONFORMANCE_NAMESPACES);
      emptyHarness.setCurrentTimeMs(nowMs);
      const emptyMovementQuery = {
        kind: "bundleDetail" as const,
        bundleId: bundles.target,
        window: "7d" as const,
      };
      const emptyMovementPreparing = preparingReport(
        await emptyHarness.model.getReport({ query: emptyMovementQuery }),
      );
      const emptyMovementPublicationId = await completeJob(
        emptyHarness,
        emptyMovementPreparing.job.id,
      );
      expect(
        await drainReportPages(emptyHarness, {
          publicationId: emptyMovementPublicationId,
          section: "movementSeries",
          metric: "installed",
          limit: 3,
        }),
      ).toEqual(series(nowMs - 6 * dayMs, 7, dayMs, new Map()));
      expect(
        await drainReportPages(emptyHarness, {
          publicationId: emptyMovementPublicationId,
          section: "movementCohorts",
          metric: "installed",
          limit: 3,
        }),
      ).toEqual([]);

      const emptyActiveQuery = {
        kind: "activeOverview" as const,
        window: "30d" as const,
      };
      const emptyActivePreparing = preparingReport(
        await emptyHarness.model.getReport({ query: emptyActiveQuery }),
      );
      const emptyActivePublicationId = await completeJob(
        emptyHarness,
        emptyActivePreparing.job.id,
      );
      expect(
        await drainReportPages(emptyHarness, {
          publicationId: emptyActivePublicationId,
          section: "activeSeries",
          limit: 8,
        }),
      ).toEqual(series(nowMs - 30 * dayMs, 30, dayMs, new Map()));
      expect(
        await drainReportPages(emptyHarness, {
          publicationId: emptyActivePublicationId,
          section: "bundleDistribution",
          limit: 8,
        }),
      ).toEqual([]);
      expect(
        await drainReportPages(emptyHarness, {
          publicationId: emptyActivePublicationId,
          section: "activeBundleSeries",
          limit: 8,
        }),
      ).toEqual([]);

      const emptySummariesQuery = {
        kind: "bundleSummaries" as const,
        bundleIds: [],
        window: "all" as const,
      };
      const emptySummariesPreparing = preparingReport(
        await emptyHarness.model.getReport({ query: emptySummariesQuery }),
      );
      await completeJob(emptyHarness, emptySummariesPreparing.job.id);
      expect(
        readyReport(
          await emptyHarness.model.getReport({ query: emptySummariesQuery }),
        ).data,
      ).toMatchObject({ kind: "bundleSummaries", summary: [] });

      const emptyInstallationsQuery = {
        kind: "installationOverview" as const,
      };
      const emptyInstallationsPreparing = preparingReport(
        await emptyHarness.model.getReport({
          query: emptyInstallationsQuery,
        }),
      );
      const emptyInstallationsPublicationId = await completeJob(
        emptyHarness,
        emptyInstallationsPreparing.job.id,
      );
      expect(
        readyReport(
          await emptyHarness.model.getReport({
            query: emptyInstallationsQuery,
          }),
        ).data,
      ).toMatchObject({
        kind: "installationOverview",
        summary: { trackedInstallations: 0 },
      });
      expect(
        await drainReportPages(emptyHarness, {
          publicationId: emptyInstallationsPublicationId,
          section: "bundleDistribution",
          limit: 8,
        }),
      ).toEqual([]);
    });

    it("persists active jobs and complete publications across reopen", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      harness.setCurrentTimeMs(1_000);
      const input = {
        kind: "contains" as const,
        query: "install",
        limit: 10,
      };
      const preparing = await harness.model.pageInstallations(input);
      expect(preparing.state).toBe("preparing");
      if (preparing.state !== "preparing") {
        throw new Error("expected preparation");
      }
      await expect(
        harness.runJobStep(preparing.job.id, {
          maxItems: 4_097,
          maxRequests: 1,
        }),
      ).rejects.toThrow();
      await expect(
        harness.runJobStep(preparing.job.id, {
          maxItems: 1,
          maxRequests: 4_097,
        }),
      ).rejects.toThrow();
      const partial = await runBoundedJobStep(harness, preparing.job.id, {
        maxItems: 1,
        maxRequests: 1,
      });
      expect(["running", "idle"]).toContain(partial.state);

      const activeAfterReopen = await harness.reopen();
      expect(activeAfterReopen.model).not.toBe(harness.model);
      expect(activeAfterReopen.otherNamespaceModel).not.toBe(
        harness.otherNamespaceModel,
      );
      const stillPreparing =
        await activeAfterReopen.model.pageInstallations(input);
      expect(stillPreparing).toMatchObject({
        state: "preparing",
        job: { id: preparing.job.id },
      });
      expect(activeAfterReopen.publicationStateForJob(preparing.job.id)).toBe(
        "absent",
      );

      const publicationId = await completeJob(
        activeAfterReopen,
        preparing.job.id,
      );
      const completeAfterReopen = await activeAfterReopen.reopen();
      expect(completeAfterReopen.publicationStateForJob(preparing.job.id)).toBe(
        "complete",
      );
      const ready = readyPage(
        await completeAfterReopen.model.pageInstallations({
          ...input,
          publicationId,
        }),
      );
      expect(ready.data.consistency.cutoff).toMatchObject({
        kind: "publication",
        publication: { id: publicationId },
      });
    });

    it("surfaces durable migration poison and typed publication expiry", async () => {
      const harness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(harness);
      harness.setCurrentTimeMs(1_000);
      await harness.insertMigrationPoisonRow();
      const poisonedQuery = {
        query: {
          kind: "activeOverview" as const,
          window: "7d" as const,
          userId: "poison",
        },
      };
      const preparing = preparingReport(
        await harness.model.getReport(poisonedQuery),
      );
      const failedStep = await runBoundedJobStep(harness, preparing.job.id, {
        maxItems: 100,
        maxRequests: 10,
      });
      expect(failedStep).toMatchObject({
        state: "failed",
        jobId: preparing.job.id,
      });
      const reopened = await harness.reopen();
      const failed = await reopened.model.getReport(poisonedQuery);
      expect(failed).toEqual({
        state: "failed",
        versions: failed.state === "failed" ? failed.versions : undefined,
        error: { code: "migration-poison", jobId: preparing.job.id },
      });
      await expect(reopened.model.getReport(poisonedQuery)).resolves.toEqual(
        failed,
      );

      const expiryHarness = await createHarness(CONFORMANCE_NAMESPACES);
      await appendFixtures(expiryHarness);
      expiryHarness.setCurrentTimeMs(1_000);
      const reportPreparing = preparingReport(
        await expiryHarness.model.getReport({
          query: {
            kind: "bundleDetail",
            bundleId: bundles.two,
            window: "all",
          },
        }),
      );
      const publicationId = await completeJob(
        expiryHarness,
        reportPreparing.job.id,
      );
      await expiryHarness.expirePublication(publicationId);
      const expired: InsightsReportPage = await expiryHarness.model.pageReport({
        publicationId,
        section: "activeSeries",
        limit: 10,
      });
      expect(expired).toEqual({ state: "expired", publicationId });
    });
  });
};
