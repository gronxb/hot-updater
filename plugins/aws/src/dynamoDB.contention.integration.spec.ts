import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  createDatabaseEngine,
  createKvAdapter,
  legacyFacadeSchema,
  migrateLegacyFacade,
  type RetryOptions,
} from "@hot-updater/server/database";
import { insights, insightsSchema } from "@hot-updater/server/plugins/insights";
import {
  runContentionHarness,
  withAdapterLatency,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type DynamoDBLocal,
  startDynamoDBLocal,
} from "./dynamoDB.integration-fixture";
import { createDynamoDBStore } from "./dynamoDBStore";

/** PRD D8: B3's rollout on DynamoDB Local, 16 writers, zero exhausted retries, at most 10% retried. */
const INSTALLS = 3000;
const RATE_PER_SECOND = 100;
const WRITERS = 16;
const LATENCY_MS = 5;

const move = (
  n: number,
  install: number,
  release: "a" | "b",
  receivedAt: number,
) =>
  ({
    id: `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    type: "UPDATE_APPLIED",
    install_id: `install-${install}`,
    user_id: `user-${install}`,
    from_release_id: release === "b" ? "release-a" : "release-0",
    from_bundle_id: release === "b" ? "bundle-a" : "bundle-0",
    to_release_id: `release-${release}`,
    to_bundle_id: `bundle-${release}`,
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      username: null,
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: receivedAt,
  }) as BundleEventRow;

let local: DynamoDBLocal;
beforeAll(async () => {
  local = await startDynamoDBLocal();
}, 180_000);
afterAll(async () => {
  await local?.stop();
});

describe("Insights rollout gate on DynamoDB Local", () => {
  it(`records ${INSTALLS} A→B moves at ${RATE_PER_SECOND}/s over ${WRITERS} writers with no exhausted retries and at most 10% retried`, async () => {
    const adapter = createKvAdapter({
      store: createDynamoDBStore({
        client: local.client,
        tableName: local.tableName(),
      }),
    });
    await migrateLegacyFacade(adapter, "dynamoDB");
    const module = { id: "insights", schema: insightsSchema } as const;
    const apiOf = (latencyMs: number, retry?: RetryOptions) =>
      insights().init({
        db: createDatabaseEngine({
          adapter:
            latencyMs > 0 ? withAdapterLatency(adapter, latencyMs) : adapter,
          schema: legacyFacadeSchema,
          ...(retry === undefined ? {} : { retry }),
        }).database(module),
        core: {},
        now: Date.now,
      }).api;

    const seeded = apiOf(0, { attempts: 64, baseDelayMs: 1, maxDelayMs: 20 });
    const start = Date.now() - 2 * 3_600_000;
    const seed = await runContentionHarness({
      transactions: INSTALLS,
      ratePerSecond: 5000,
      concurrency: 4,
      run: (install) =>
        seeded.recordEvent(move(install, install, "a", start + install)),
    });
    expect(seed.errors).toEqual({});

    const retries = { rerun: 0, resend: 0, retriedTransactions: 0 };
    const rollout = apiOf(LATENCY_MS, {
      onRetry: (kind, attempt) => {
        retries[kind] += 1;
        if (attempt === 1) retries.retriedTransactions += 1;
      },
    });
    const report = await runContentionHarness({
      transactions: INSTALLS,
      ratePerSecond: RATE_PER_SECOND,
      concurrency: WRITERS,
      run: (install) =>
        rollout.recordEvent(move(INSTALLS + install, install, "b", Date.now())),
    });
    const retried = retries.retriedTransactions / INSTALLS;
    console.info(
      "dynamodb-rollout-gate",
      JSON.stringify({ ...report, ...retries, retried }),
    );
    expect(report.errors).toEqual({});
    expect(report.committed).toBe(INSTALLS);
    expect(retried).toBeLessThanOrEqual(0.1);
  }, 600_000);
});
