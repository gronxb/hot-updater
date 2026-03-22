import { PGlite } from "@electric-sql/pglite";
import type { AppVersionGetBundlesArgs, UpdateInfo } from "../../../core/src";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  NIL_UUID,
  isCohortEligibleForUpdate,
} from "../../../core/src";
import { filterCompatibleAppVersions } from "../../../../plugins/plugin-core/src";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { bench, describe } from "vitest";
import { kyselyAdapter } from "../adapters/kysely";
import { createOrmDatabaseCore } from "./ormCore";

const BUNDLE_COUNT = 8_000;
const BENCH_APP_VERSION = "1.0.0";
const BENCH_PLATFORM = "ios" as const;
const BENCH_CHANNEL = "production";

const createBundleRow = (index: number) => ({
  id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  platform: BENCH_PLATFORM,
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${index}`,
  git_commit_hash: `commit-${index}`,
  message: `bundle-${index}`,
  channel: BENCH_CHANNEL,
  storage_uri: `s3://bench/bundles/${index}.zip`,
  target_app_version: "*",
  fingerprint_hash: `fingerprint-${index % 10}`,
  metadata: { index },
  rollout_cohort_count: DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: null,
});

const parseTargetCohorts = (value: unknown): string[] | null => {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      return null;
    }
  }
  return null;
};

const oldOrmCoreGetUpdateInfo = async (
  db: Kysely<any>,
  args: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const toUpdateInfo = (
    row: {
      id: string;
      should_force_update: boolean;
      message: string | null;
      storage_uri: string | null;
      file_hash: string;
    },
    status: "UPDATE" | "ROLLBACK",
  ): UpdateInfo => ({
    id: row.id,
    shouldForceUpdate:
      status === "ROLLBACK" ? true : Boolean(row.should_force_update),
    message: row.message ?? null,
    status,
    storageUri: row.storage_uri ?? null,
    fileHash: row.file_hash ?? null,
  });

  const isEligibleForUpdate = (
    row: {
      id: string;
      rollout_cohort_count?: number | null;
      target_cohorts?: unknown | null;
    },
    cohort: string | undefined,
  ) => {
    return isCohortEligibleForUpdate(
      row.id,
      cohort,
      row.rollout_cohort_count ?? null,
      parseTargetCohorts(row.target_cohorts),
    );
  };

  const versionRows = await db
    .selectFrom("bundles")
    .select("target_app_version")
    .where("platform", "=", args.platform)
    .execute();

  const allTargetVersions = Array.from(
    new Set(
      versionRows
        .map((row) => row.target_app_version)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const compatibleVersions = filterCompatibleAppVersions(
    allTargetVersions,
    args.appVersion,
  );

  const baseRows =
    compatibleVersions.length === 0
      ? []
      : await db
          .selectFrom("bundles")
          .select([
            "id",
            "should_force_update",
            "message",
            "storage_uri",
            "file_hash",
            "rollout_cohort_count",
            "target_cohorts",
            "target_app_version",
          ])
          .where("enabled", "=", true)
          .where("platform", "=", args.platform)
          .where("id", ">=", args.minBundleId ?? NIL_UUID)
          .where("channel", "=", args.channel ?? BENCH_CHANNEL)
          .where("target_app_version", "is not", null)
          .execute();

  const candidates = baseRows
    .filter((row) =>
      row.target_app_version
        ? compatibleVersions.includes(row.target_app_version)
        : false,
    )
    .sort((a, b) => b.id.localeCompare(a.id));

  const updateCandidate =
    candidates.find(
      (row) =>
        row.id.localeCompare(args.bundleId) > 0 &&
        isEligibleForUpdate(row, args.cohort),
    ) ?? null;

  if (args.bundleId === NIL_UUID) {
    return updateCandidate ? toUpdateInfo(updateCandidate, "UPDATE") : null;
  }

  const currentBundle = candidates.find((row) => row.id === args.bundleId);
  const currentBundleEligible = currentBundle
    ? isEligibleForUpdate(currentBundle, args.cohort)
    : false;
  const rollbackCandidate =
    candidates.find((row) => row.id.localeCompare(args.bundleId) < 0) ?? null;

  if (currentBundleEligible) {
    return updateCandidate ? toUpdateInfo(updateCandidate, "UPDATE") : null;
  }
  if (updateCandidate) {
    return toUpdateInfo(updateCandidate, "UPDATE");
  }
  if (rollbackCandidate) {
    return toUpdateInfo(rollbackCandidate, "ROLLBACK");
  }
  if (args.minBundleId && args.bundleId.localeCompare(args.minBundleId) <= 0) {
    return null;
  }
  return {
    id: NIL_UUID,
    message: null,
    shouldForceUpdate: true,
    status: "ROLLBACK",
    storageUri: null,
    fileHash: null,
  };
};

const pg = new PGlite();
const kysely = new Kysely({ dialect: new PGliteDialect(pg) });
const ormCore = createOrmDatabaseCore({
  database: kyselyAdapter({
    db: kysely,
    provider: "postgresql",
  }),
  resolveFileUrl: async () => null,
});

const migration = await ormCore.createMigrator().migrateToLatest({
  mode: "from-schema",
  updateSettings: true,
});
await migration.execute();

const rows = Array.from({ length: BUNDLE_COUNT }, (_, index) =>
  createBundleRow(index + 1),
);

for (let index = 0; index < rows.length; index += 500) {
  await kysely
    .insertInto("bundles")
    .values(rows.slice(index, index + 500))
    .execute();
}

describe("orm update check benchmark", () => {
  const args: AppVersionGetBundlesArgs = {
    _updateStrategy: "appVersion",
    appVersion: BENCH_APP_VERSION,
    bundleId: NIL_UUID,
    platform: BENCH_PLATFORM,
    channel: BENCH_CHANNEL,
  };

  bench(
    "ormCore legacy appVersion scan",
    async () => {
      await oldOrmCoreGetUpdateInfo(kysely, args);
    },
    { warmupIterations: 3, iterations: 15 },
  );

  bench(
    "ormCore current paged appVersion scan",
    async () => {
      await ormCore.api.getUpdateInfo(args);
    },
    { warmupIterations: 3, iterations: 15 },
  );
});
