import {
  isDatabaseMetadataObject,
  type BundleRow,
  type ReleaseCatalogRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import type { Db } from "mongodb";

import {
  compileLegacyReleaseCatalogBackfill,
  type LegacyBundlePolicyRow,
  type ReleaseCatalogBackfillResult,
} from "./releaseCatalogBackfill";

export const legacyMongoBundlePolicyFields = [
  "should_force_update",
  "enabled",
  "message",
  "channel",
  "channel_id",
  "target_app_version",
  "fingerprint_hash",
  "rollout_cohort_count",
  "target_cohorts",
] as const;

type MongoLegacyBundleDocument = LegacyBundlePolicyRow &
  Partial<BundleRow> & {
    readonly _hot_updater_deletion_token?: unknown;
  };

export interface PreparedMongoReleaseCatalogBackfill {
  readonly artifacts: readonly BundleRow[];
  readonly backfill: ReleaseCatalogBackfillResult | null;
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid legacy MongoDB Bundle ${field} during Release Catalog migration.`,
    );
  }
  return value;
};

const nullableString = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
};

const normalizeArtifact = (row: MongoLegacyBundleDocument): BundleRow => {
  const platform = requiredString(row.platform, "platform");
  if (platform !== "ios" && platform !== "android") {
    throw new Error(
      "Invalid legacy MongoDB Bundle platform during Release Catalog migration.",
    );
  }
  const metadata = row.metadata ?? {};
  if (!isDatabaseMetadataObject(metadata)) {
    throw new Error(
      "Invalid legacy MongoDB Bundle metadata during Release Catalog migration.",
    );
  }
  return {
    id: requiredString(row.id, "id"),
    platform,
    file_hash: requiredString(row.file_hash, "file_hash"),
    git_commit_hash: nullableString(row.git_commit_hash, "git_commit_hash"),
    storage_uri: requiredString(row.storage_uri, "storage_uri"),
    metadata,
    manifest_storage_uri: nullableString(
      row.manifest_storage_uri,
      "manifest_storage_uri",
    ),
    manifest_file_hash: nullableString(
      row.manifest_file_hash,
      "manifest_file_hash",
    ),
    asset_base_storage_uri: nullableString(
      row.asset_base_storage_uri,
      "asset_base_storage_uri",
    ),
  };
};

const hasLegacyPolicy = (row: MongoLegacyBundleDocument): boolean =>
  legacyMongoBundlePolicyFields.some((field) => field in row);

const normalizeLegacyPolicy = (
  row: MongoLegacyBundleDocument,
): LegacyBundlePolicyRow => ({
  id: row.id,
  platform: row.platform,
  channel: row.channel,
  enabled: row.enabled,
  should_force_update: row.should_force_update,
  message: row.message ?? null,
  target_app_version: row.target_app_version ?? null,
  fingerprint_hash: row.fingerprint_hash ?? null,
  rollout_cohort_count: row.rollout_cohort_count ?? 1000,
  target_cohorts: row.target_cohorts ?? [],
});

export const prepareMongoReleaseCatalogBackfill = async ({
  authorityId,
  db,
}: {
  readonly authorityId: string | undefined;
  readonly db: Db;
}): Promise<PreparedMongoReleaseCatalogBackfill> => {
  const rows = await db
    .collection<MongoLegacyBundleDocument>("bundles")
    .find({})
    .toArray();
  rows.sort((left, right) =>
    requiredString(left.id, "id").localeCompare(requiredString(right.id, "id")),
  );
  const activeRows = rows.filter(
    (row) => row._hot_updater_deletion_token === undefined,
  );
  const policyRows = activeRows.filter(hasLegacyPolicy);
  if (policyRows.length !== 0 && policyRows.length !== activeRows.length) {
    throw new Error(
      "MongoDB Release Catalog migration found a partial Bundle policy backfill.",
    );
  }
  return {
    artifacts: rows.map(normalizeArtifact),
    backfill:
      policyRows.length === 0
        ? null
        : await compileLegacyReleaseCatalogBackfill({
            authorityId,
            rows: policyRows.map(normalizeLegacyPolicy),
          }),
  };
};

export const applyMongoReleaseCatalogBackfill = async ({
  db,
  prepared,
  resolveChannelId,
}: {
  readonly db: Db;
  readonly prepared: PreparedMongoReleaseCatalogBackfill;
  readonly resolveChannelId: (channelName: string) => string;
}): Promise<void> => {
  if (prepared.backfill) {
    const releases = db.collection<ReleaseRow>("releases");
    for (const release of prepared.backfill.releases) {
      const row = {
        ...release.row,
        channel_id: resolveChannelId(release.channelName),
      };
      await releases.replaceOne({ id: row.id }, row, { upsert: true });
    }
    const catalogs = db.collection<ReleaseCatalogRow>("release_catalogs");
    for (const catalog of prepared.backfill.catalogs) {
      const row = {
        ...catalog.row,
        channel_id: resolveChannelId(catalog.channelName),
      };
      await catalogs.replaceOne({ scope_key: row.scope_key }, row, {
        upsert: true,
      });
    }
  }

  const bundles = db.collection<BundleRow>("bundles");
  const unsetPolicy: Record<string, true> = Object.fromEntries(
    legacyMongoBundlePolicyFields.map((field) => [field, true]),
  );
  for (const artifact of prepared.artifacts) {
    await bundles.updateOne(
      { id: artifact.id },
      { $set: artifact, $unset: unsetPolicy },
    );
  }
};

export const validateMongoReleaseCatalogBackfill = async ({
  authorityId,
  db,
}: {
  readonly authorityId: string | undefined;
  readonly db: Db;
}): Promise<void> => {
  const bundles = await db
    .collection<MongoLegacyBundleDocument>("bundles")
    .find({})
    .toArray();
  for (const bundle of bundles) {
    normalizeArtifact(bundle);
    if (hasLegacyPolicy(bundle)) {
      throw new Error(
        "MongoDB Bundle policy fields remain after Release Catalog backfill.",
      );
    }
  }
  const activeBundleIds = new Set(
    bundles
      .filter((bundle) => bundle._hot_updater_deletion_token === undefined)
      .map((bundle) => requiredString(bundle.id, "id")),
  );
  if (activeBundleIds.size === 0) return;
  if (authorityId === undefined || authorityId.length === 0) {
    throw new Error(
      "Release Catalog migration requires the configured authorityId when legacy Bundles exist.",
    );
  }
  const releases = await db
    .collection<ReleaseRow>("releases")
    .find({ kind: "BUNDLE" })
    .toArray();
  const releasesByBundleId = new Map(
    releases.map((release) => [release.bundle_id, release]),
  );
  const scopeKeys = new Set<string>();
  for (const bundleId of activeBundleIds) {
    const release = releasesByBundleId.get(bundleId);
    if (!release || release.id !== bundleId || release.revision !== 1) {
      throw new Error(
        `MongoDB Release backfill is incomplete for Bundle ${bundleId}.`,
      );
    }
    scopeKeys.add(release.scope_key);
  }
  const catalogs = await db
    .collection<ReleaseCatalogRow>("release_catalogs")
    .find({ scope_key: { $in: [...scopeKeys] } })
    .toArray();
  const validScopeKeys = new Set(
    catalogs
      .filter(
        (catalog) =>
          catalog.authority_id === authorityId &&
          catalog.generation === 1 &&
          typeof catalog.payload === "string" &&
          typeof catalog.catalog_hash === "string",
      )
      .map((catalog) => catalog.scope_key),
  );
  for (const scopeKey of scopeKeys) {
    if (!validScopeKeys.has(scopeKey)) {
      throw new Error(
        `MongoDB Release Catalog backfill is incomplete for scope ${scopeKey}.`,
      );
    }
  }
};
