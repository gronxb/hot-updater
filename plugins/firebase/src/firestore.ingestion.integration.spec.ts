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
import { describe, expect, it } from "vitest";

import { createFirestoreTestDatabase } from "../test-utils/createFirestoreTestDatabase";
import { createFirestoreStore } from "./firestoreStore";

/**
 * PRD D9: B3's rollout moves through the Firestore store, measured and
 * recorded in plans/evidence/firestore-ingestion-ceiling.md.
 * HOT_UPDATER_INGESTION_CEILING=1 runs the whole ladder of rates, the same as
 * Supabase's. The emulator has no network round trips and ends a contended
 * lock wait only after 2 seconds, so it measures the store's behavior, not
 * Firestore's throughput.
 */
const LADDER = process.env.HOT_UPDATER_INGESTION_CEILING === "1";
const MOVES = LADDER ? 600 : 200;
const RATES = LADDER ? [50, 100, 200, 400, 800] : [50];
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

describe("Firestore ingestion", () => {
  it("records the Insights ingestion ceiling on the Firestore emulator", async () => {
    const collection = `ingestion_${process.pid}`;
    const { firestore, clearCollection } = createFirestoreTestDatabase(
      "firebase-ingestion-test",
    );
    await clearCollection(collection);
    const adapter = createKvAdapter({
      store: createFirestoreStore({ firestore, collection }),
    });
    await migrateLegacyFacade(adapter, "firestore");
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
    const steps = [];
    for (const [step, rate] of RATES.entries()) {
      // Each step moves its own installations, first onto A, then A→B.
      const first = step * MOVES;
      const seed = await runContentionHarness({
        transactions: MOVES,
        ratePerSecond: 5000,
        concurrency: 4,
        run: (i) =>
          seeded.recordEvent(
            move(2 * first + i, first + i, "a", start + first + i),
          ),
      });
      expect(seed.errors).toEqual({});
      const retries = { rerun: 0, resend: 0, retriedTransactions: 0 };
      const api = apiOf(LATENCY_MS, {
        onRetry: (kind, attempt) => {
          retries[kind] += 1;
          if (attempt === 1) retries.retriedTransactions += 1;
        },
      });
      const report = await runContentionHarness({
        transactions: MOVES,
        ratePerSecond: rate,
        concurrency: WRITERS,
        run: (i) =>
          api.recordEvent(
            move(2 * first + MOVES + i, first + i, "b", Date.now()),
          ),
      });
      steps.push({
        rate,
        ...report,
        ...retries,
        retried: retries.retriedTransactions / MOVES,
        achieved: Math.round(report.committed / (report.durationMs / 1000)),
      });
    }
    // The ceiling: the highest rate kept up with, no errors and at most 5% retried.
    const ceiling = steps
      .filter(
        (step) =>
          Object.keys(step.errors).length === 0 &&
          step.retried <= 0.05 &&
          step.achieved >= step.rate * 0.9,
      )
      .at(-1)?.rate;
    console.info(
      "firestore-ingestion-ceiling",
      JSON.stringify({
        writers: WRITERS,
        latencyMs: LATENCY_MS,
        ceiling,
        steps,
      }),
    );
    for (const { committed, errors } of steps) {
      // Under contention a move may run out of retries, and nothing else fails.
      const { DatabaseConflictError: conflicts = 0, ...others } = errors;
      expect(others).toEqual({});
      expect(committed + conflicts).toBe(MOVES);
    }
    await clearCollection(collection);
  }, 900_000);
});
