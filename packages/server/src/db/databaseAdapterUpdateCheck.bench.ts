import { bench, describe } from "vitest";

import {
  bundleToRow,
  createDatabaseAdapter,
  type DatabaseAdapter,
} from "../../../../plugins/plugin-core/src";
import type { AppVersionGetBundlesArgs, Bundle } from "../../../core/src";
import { DEFAULT_ROLLOUT_COHORT_COUNT, NIL_UUID } from "../../../core/src";
import {
  matchesAll,
  queryRows,
} from "../../../test-utils/test/inMemoryDatabaseQuery";
import { createDatabaseAdapterCore } from "./databaseAdapterCore";

const BUNDLE_COUNT = 20_000;
const BENCH_APP_VERSION = "1.0.0";
const BENCH_PLATFORM = "ios" as const;
const BENCH_CHANNEL = "production";
const BENCH_CHANNEL_ROW = {
  id: "channel-production",
  name: BENCH_CHANNEL,
} as const;

class BenchmarkMutationError extends Error {
  readonly name = "BenchmarkMutationError";

  constructor() {
    super("The update-check benchmark adapter is read-only.");
  }
}

const createBundle = (index: number): Bundle => ({
  id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  platform: BENCH_PLATFORM,
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${index}`,
  gitCommitHash: `commit-${index}`,
  message: `bundle-${index}`,
  channel: BENCH_CHANNEL,
  storageUri: `s3://bench/bundles/${index}.zip`,
  targetAppVersion: "*",
  fingerprintHash: `fingerprint-${index % 10}`,
  metadata: { app_version: String(index) },
  rolloutCohortCount: DEFAULT_ROLLOUT_COHORT_COUNT,
  targetCohorts: null,
});

const createBenchAdapter = (bundles: readonly Bundle[]): DatabaseAdapter => {
  const rows = bundles.map((bundle) =>
    bundleToRow(bundle, BENCH_CHANNEL_ROW.id),
  );
  return createDatabaseAdapter({
    name: "bench-v2-adapter",
    adapter: () => ({
      async create() {
        throw new BenchmarkMutationError();
      },
      async update() {
        throw new BenchmarkMutationError();
      },
      async delete() {
        throw new BenchmarkMutationError();
      },
      async count(input) {
        if (input.model !== "bundles") return 0;
        return rows.filter((row) => matchesAll<"bundles">(row, input.where))
          .length;
      },
      async findOne(input) {
        switch (input.model) {
          case "bundles":
            return (
              rows.find((row) => matchesAll<"bundles">(row, input.where)) ??
              null
            );
          case "channels":
            return matchesAll<"channels">(BENCH_CHANNEL_ROW, input.where)
              ? BENCH_CHANNEL_ROW
              : null;
          case "bundle_patches":
          case "bundle_events":
            return null;
        }
      },
      async findMany(input) {
        switch (input.model) {
          case "bundles":
            return queryRows<"bundles">(
              rows,
              input.where,
              input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined),
              input.distinctOn,
              input.offset,
              input.limit,
            );
          case "bundle_patches":
          case "bundle_events":
            return [];
          case "channels":
            return [BENCH_CHANNEL_ROW].slice(
              input.offset,
              input.offset + input.limit,
            );
        }
      },
    }),
  });
};

describe("database adapter update check benchmark", () => {
  const bundles = Array.from({ length: BUNDLE_COUNT }, (_, index) =>
    createBundle(index + 1),
  );
  const args: AppVersionGetBundlesArgs = {
    _updateStrategy: "appVersion",
    appVersion: BENCH_APP_VERSION,
    bundleId: NIL_UUID,
    platform: BENCH_PLATFORM,
    channel: BENCH_CHANNEL,
  };
  const api = createDatabaseAdapterCore(
    createBenchAdapter(bundles),
    async () => null,
  ).api;

  bench(
    "v2 low adapter paged update check",
    async () => {
      await api.getUpdateInfo(args);
    },
    { warmupIterations: 5, iterations: 20 },
  );
});
