import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  compileReleaseCatalog,
  extractTimestampFromUUIDv7,
  releaseRowToRelease,
  type ReleaseCatalogRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import { sql, type QueryExecutorProvider } from "kysely";

import type { ORMSQLProvider } from "./types";

export type LegacyBundlePolicyRow = {
  readonly id: unknown;
  readonly platform: unknown;
  readonly channel: unknown;
  readonly enabled: unknown;
  readonly should_force_update: unknown;
  readonly message: unknown;
  readonly target_app_version: unknown;
  readonly fingerprint_hash: unknown;
  readonly rollout_cohort_count: unknown;
  readonly target_cohorts: unknown;
};

export interface ReleaseCatalogBackfillResult {
  readonly catalogs: readonly {
    readonly channelName: string;
    readonly row: ReleaseCatalogRow;
  }[];
  readonly releases: readonly {
    readonly channelName: string;
    readonly row: ReleaseRow;
  }[];
}

const parseBoolean = (value: unknown, field: string): boolean => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`Invalid legacy Bundle ${field} during Release backfill.`);
};

const parseString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid legacy Bundle ${field} during Release backfill.`);
  }
  return value;
};

const parseNullableString = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  return parseString(value, field);
};

const parseTargetCohorts = (value: unknown): readonly string[] => {
  if (value === null || value === undefined) return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(
        "Invalid legacy Bundle target_cohorts during Release backfill.",
      );
    }
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((cohort) => typeof cohort === "string")
  ) {
    throw new Error(
      "Invalid legacy Bundle target_cohorts during Release backfill.",
    );
  }
  return parsed;
};

export const compileLegacyReleaseCatalogBackfill = async ({
  authorityId,
  rows,
}: {
  readonly authorityId: string | undefined;
  readonly rows: readonly LegacyBundlePolicyRow[];
}): Promise<ReleaseCatalogBackfillResult> => {
  if (rows.length === 0) return { catalogs: [], releases: [] };
  if (authorityId === undefined || authorityId.length === 0) {
    throw new Error(
      "Release Catalog migration requires the configured authorityId when legacy Bundles exist.",
    );
  }

  const scopes = new Map<
    string,
    {
      readonly channelName: string;
      readonly channelKey: string;
      readonly fingerprintHash: string | null;
      readonly platform: "ios" | "android";
      readonly releases: ReleaseRow[];
      readonly strategy: "APP_VERSION" | "FINGERPRINT";
    }
  >();

  for (const legacy of rows) {
    const id = parseString(legacy.id, "id");
    const platform = parseString(legacy.platform, "platform");
    if (platform !== "ios" && platform !== "android") {
      throw new Error(
        "Invalid legacy Bundle platform during Release backfill.",
      );
    }
    const channel = parseString(legacy.channel, "channel");
    const channelKey = encodeChannelKey(channel);
    const targetAppVersion = parseNullableString(
      legacy.target_app_version,
      "target_app_version",
    );
    const fingerprintHash = parseNullableString(
      legacy.fingerprint_hash,
      "fingerprint_hash",
    );
    if ((targetAppVersion === null) === (fingerprintHash === null)) {
      throw new Error(
        "Legacy Bundle must define exactly one Release target during backfill.",
      );
    }
    const strategy = fingerprintHash === null ? "APP_VERSION" : "FINGERPRINT";
    const scopeKey =
      strategy === "APP_VERSION"
        ? createReleaseCatalogScopeKey({
            authorityId,
            channelKey,
            platform,
            strategy,
          })
        : createReleaseCatalogScopeKey({
            authorityId,
            channelKey,
            fingerprintHash: fingerprintHash ?? "",
            platform,
            strategy,
          });
    const rolloutCohortCount = Number(legacy.rollout_cohort_count ?? 1000);
    if (
      !Number.isInteger(rolloutCohortCount) ||
      rolloutCohortCount < 0 ||
      rolloutCohortCount > 1000
    ) {
      throw new Error(
        "Invalid legacy Bundle rollout_cohort_count during Release backfill.",
      );
    }
    const extractedTimestamp = extractTimestampFromUUIDv7(id);
    const createdAtMs = Number.isSafeInteger(extractedTimestamp)
      ? extractedTimestamp
      : 0;
    const release: ReleaseRow = {
      id,
      revision: 1,
      scope_key: scopeKey,
      channel_id: channel,
      platform,
      kind: "BUNDLE",
      bundle_id: id,
      strategy,
      target_app_version: targetAppVersion,
      fingerprint_hash: fingerprintHash,
      enabled: parseBoolean(legacy.enabled, "enabled"),
      should_force_update: parseBoolean(
        legacy.should_force_update,
        "should_force_update",
      ),
      message: parseNullableString(legacy.message, "message"),
      rollout_cohort_count: rolloutCohortCount,
      target_cohorts: parseTargetCohorts(legacy.target_cohorts),
      operation: "DEPLOY",
      source_release_id: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
    };
    const scope = scopes.get(scopeKey);
    if (scope === undefined) {
      scopes.set(scopeKey, {
        channelName: channel,
        channelKey,
        fingerprintHash,
        platform,
        releases: [release],
        strategy,
      });
    } else {
      scope.releases.push(release);
    }
  }

  const catalogs: {
    channelName: string;
    row: ReleaseCatalogRow;
  }[] = [];
  const releases: { channelName: string; row: ReleaseRow }[] = [];
  for (const [scopeKey, scope] of [...scopes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    scope.releases.sort((left, right) => left.id.localeCompare(right.id));
    releases.push(
      ...scope.releases.map((row) => ({
        channelName: scope.channelName,
        row,
      })),
    );
    const compilation = await compileReleaseCatalog({
      releases: scope.releases.map(releaseRowToRelease),
      strategy: scope.strategy,
    });
    const updatedAtMs = Math.max(
      ...scope.releases.map(({ updated_at_ms }) => updated_at_ms),
    );
    catalogs.push({
      channelName: scope.channelName,
      row: {
        scope_key: scopeKey,
        authority_id: authorityId,
        strategy: scope.strategy,
        channel_id: scope.channelName,
        channel_key: scope.channelKey,
        platform: scope.platform,
        fingerprint_hash: scope.fingerprintHash,
        generation: 1,
        payload: compilation.canonicalPayload,
        catalog_hash: compilation.catalogHash,
        byte_size: compilation.byteSize,
        is_tombstone: compilation.payload.releaseDescriptors.length === 0,
        updated_at_ms: updatedAtMs,
      },
    });
  }
  return { catalogs, releases };
};

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const nullable = (value: string | null): string =>
  value === null ? "null" : quote(value);

const bool = (value: boolean, provider: ORMSQLProvider): string =>
  provider === "mssql" ? (value ? "1" : "0") : value ? "true" : "false";

const releaseInsertSql = (
  row: ReleaseRow,
  channelName: string,
  provider: ORMSQLProvider,
): string =>
  `insert into releases (id, revision, scope_key, channel_id, platform, kind, bundle_id, strategy, target_app_version, fingerprint_hash, enabled, should_force_update, message, rollout_cohort_count, target_cohorts, operation, source_release_id, created_at_ms, updated_at_ms) values (${[
    quote(row.id),
    String(row.revision),
    quote(row.scope_key),
    `(select id from channels where name = ${quote(channelName)})`,
    quote(row.platform),
    quote(row.kind),
    nullable(row.bundle_id),
    quote(row.strategy),
    nullable(row.target_app_version),
    nullable(row.fingerprint_hash),
    bool(row.enabled, provider),
    bool(row.should_force_update, provider),
    nullable(row.message),
    String(row.rollout_cohort_count),
    quote(JSON.stringify(row.target_cohorts)),
    quote(row.operation),
    "null",
    String(row.created_at_ms),
    String(row.updated_at_ms),
  ].join(", ")})`;

export const createReleaseCatalogBackfillInsertSql = ({
  backfill,
  provider,
}: {
  readonly backfill: ReleaseCatalogBackfillResult;
  readonly provider: ORMSQLProvider;
}): readonly string[] => {
  const statements: string[] = [];
  for (const release of backfill.releases) {
    statements.push(
      releaseInsertSql(release.row, release.channelName, provider),
    );
  }
  for (const catalog of backfill.catalogs) {
    const row = catalog.row;
    statements.push(
      `insert into release_catalogs (scope_key, authority_id, strategy, channel_id, channel_key, platform, fingerprint_hash, generation, payload, catalog_hash, byte_size, is_tombstone, updated_at_ms) values (${[
        quote(row.scope_key),
        quote(row.authority_id),
        quote(row.strategy),
        `(select id from channels where name = ${quote(catalog.channelName)})`,
        quote(row.channel_key),
        quote(row.platform),
        nullable(row.fingerprint_hash),
        String(row.generation),
        quote(row.payload),
        quote(row.catalog_hash),
        String(row.byte_size),
        bool(row.is_tombstone, provider),
        String(row.updated_at_ms),
      ].join(", ")})`,
    );
  }
  return statements;
};

export const createReleaseCatalogBackfillSql = async ({
  authorityId,
  db,
  provider,
  sourceVersion,
}: {
  readonly authorityId: string | undefined;
  readonly db: QueryExecutorProvider;
  readonly provider: ORMSQLProvider;
  readonly sourceVersion: string;
}): Promise<readonly string[]> => {
  const hasRolloutPolicy = sourceVersion !== "0.21.0";
  const rolloutCohortCount = hasRolloutPolicy
    ? sql.ref("rollout_cohort_count")
    : sql.lit(1000);
  const targetCohorts = hasRolloutPolicy
    ? sql.ref("target_cohorts")
    : sql.lit(JSON.stringify([]));
  const result = await sql<LegacyBundlePolicyRow>`select
    id,
    platform,
    channel,
    enabled,
    should_force_update,
    message,
    target_app_version,
    fingerprint_hash,
    ${rolloutCohortCount} as rollout_cohort_count,
    ${targetCohorts} as target_cohorts
  from bundles
  order by id`.execute(db);
  const backfill = await compileLegacyReleaseCatalogBackfill({
    authorityId,
    rows: result.rows,
  });
  return createReleaseCatalogBackfillInsertSql({ backfill, provider });
};
