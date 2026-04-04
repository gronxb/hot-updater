import { bench, describe } from "vitest";
import type {
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabasePlugin,
} from "../../../../plugins/plugin-core/src";
import {
  calculatePagination,
  semverSatisfies,
} from "../../../../plugins/plugin-core/src";
import type {
  AppVersionGetBundlesArgs,
  Bundle,
  Platform,
  UpdateInfo,
} from "../../../core/src";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  isCohortEligibleForUpdate,
  NIL_UUID,
} from "../../../core/src";
import { createPluginDatabaseCore } from "./pluginCore";

const BUNDLE_COUNT = 20_000;
const BENCH_APP_VERSION = "1.0.0";
const BENCH_PLATFORM = "ios" as const;
const BENCH_CHANNEL = "production";

const cloneBundle = (bundle: Bundle): Bundle => ({
  ...bundle,
  metadata: bundle.metadata
    ? structuredClone(bundle.metadata)
    : bundle.metadata,
  targetCohorts: bundle.targetCohorts ? [...bundle.targetCohorts] : null,
});

const bundleMatchesWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const createBundle = (
  index: number,
  {
    platform = BENCH_PLATFORM,
    channel = BENCH_CHANNEL,
    targetAppVersion = "*",
    enabled = true,
  }: {
    platform?: Platform;
    channel?: string;
    targetAppVersion?: string | null;
    enabled?: boolean;
  } = {},
): Bundle => ({
  id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  platform,
  shouldForceUpdate: false,
  enabled,
  fileHash: `hash-${index}`,
  gitCommitHash: `commit-${index}`,
  message: `bundle-${index}`,
  channel,
  storageUri: `s3://bench/bundles/${index}.zip`,
  targetAppVersion,
  fingerprintHash: `fingerprint-${index % 10}`,
  metadata: { app_version: String(index) },
  rolloutCohortCount: DEFAULT_ROLLOUT_COHORT_COUNT,
  targetCohorts: null,
});

const createBenchPlugin = (bundles: Bundle[]): DatabasePlugin => {
  const bundlesById = new Map(bundles.map((bundle) => [bundle.id, bundle]));

  const sortByDirection = (direction: "asc" | "desc" | undefined): Bundle[] => {
    const sorted = bundles.slice().sort((a, b) => a.id.localeCompare(b.id));
    return direction === "asc" ? sorted : sorted.reverse();
  };

  return {
    name: "bench-plugin",
    async getBundleById(bundleId) {
      return bundlesById.get(bundleId) ?? null;
    },
    async getBundles(options: DatabaseBundleQueryOptions) {
      const { where, limit, offset, orderBy } = options;
      const source = sortByDirection(orderBy?.direction);
      const matched = source.filter((bundle) =>
        bundleMatchesWhere(bundle, where),
      );
      const page = matched.slice(offset, offset + limit).map(cloneBundle);

      return {
        data: page,
        pagination: calculatePagination(matched.length, { limit, offset }),
      };
    },
    async getChannels() {
      return [...new Set(bundles.map((bundle) => bundle.channel))];
    },
    async updateBundle() {
      throw new Error("Not implemented for benchmark");
    },
    async appendBundle() {
      throw new Error("Not implemented for benchmark");
    },
    async commitBundle() {},
    async deleteBundle() {
      throw new Error("Not implemented for benchmark");
    },
  };
};

const oldPluginCoreGetUpdateInfo = async (
  plugin: DatabasePlugin,
  args: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const where: DatabaseBundleQueryWhere = {
    channel: args.channel ?? BENCH_CHANNEL,
    platform: args.platform,
  };

  const { pagination } = await plugin.getBundles({
    where,
    limit: 1,
    offset: 0,
  });

  if (pagination.total === 0) {
    return null;
  }

  const { data } = await plugin.getBundles({
    where,
    limit: pagination.total,
    offset: 0,
  });

  for (const bundle of data) {
    if (!bundle.enabled) {
      continue;
    }
    if (bundle.platform !== args.platform) {
      continue;
    }
    if (bundle.channel !== (args.channel ?? BENCH_CHANNEL)) {
      continue;
    }
    if (!bundle.targetAppVersion) {
      continue;
    }
    if (!semverSatisfies(bundle.targetAppVersion, args.appVersion)) {
      continue;
    }
    if (
      !isCohortEligibleForUpdate(
        bundle.id,
        args.cohort,
        bundle.rolloutCohortCount,
        bundle.targetCohorts,
      )
    ) {
      continue;
    }

    return {
      id: bundle.id,
      message: bundle.message,
      shouldForceUpdate: bundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: bundle.storageUri,
      fileHash: bundle.fileHash,
    };
  }

  return null;
};

describe("plugin update check benchmark", () => {
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

  const plugin = createBenchPlugin(bundles);
  const currentApi = createPluginDatabaseCore(
    () => plugin,
    async () => null,
  ).api;

  bench(
    "pluginCore legacy full fetch",
    async () => {
      await oldPluginCoreGetUpdateInfo(plugin, args);
    },
    { warmupIterations: 5, iterations: 20 },
  );

  bench(
    "pluginCore current paged fetch",
    async () => {
      await currentApi.getUpdateInfo(args);
    },
    { warmupIterations: 5, iterations: 20 },
  );
});
