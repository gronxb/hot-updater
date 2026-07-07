import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  NIL_UUID,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  BundleEventListQuery,
  BundleEventPayload,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundlePatchUpdate,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginCore,
  RequestEnvContext,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  filterCompatibleAppVersions,
  markDatabaseRuntimeOpener,
  resolveUpdateInfoFromBundles,
  toBundleReadModel,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";

type D1Result<T> = {
  results?: T[];
};

type D1PreparedStatement = {
  bind: (...values: unknown[]) => {
    all: <T>() => Promise<D1Result<T>>;
    first: <T>() => Promise<T | null>;
    run: () => Promise<unknown>;
  };
};

type D1Like = {
  prepare: (sql: string) => D1PreparedStatement;
};

export interface CloudflareWorkerDatabaseEnv {
  DB: D1Like;
}

type QueryConditions = DatabaseBundleQueryWhere;

interface BuildQueryResult {
  sql: string;
  params: unknown[];
}

const buildJsonEachInClause = (
  columnName: string,
  values: string[],
  params: unknown[],
) => {
  if (values.length === 0) {
    return "1 = 0";
  }

  params.push(JSON.stringify(values));
  return `${columnName} IN (SELECT value FROM json_each(?))`;
};

interface D1WorkerBundleRow {
  id: string;
  channel: string;
  enabled: number | boolean;
  should_force_update: number | boolean;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: "ios" | "android";
  target_app_version: string | null;
  storage_uri: string;
  fingerprint_hash: string | null;
  metadata: unknown;
  manifest_storage_uri?: string | null;
  manifest_file_hash?: string | null;
  asset_base_storage_uri?: string | null;
  rollout_cohort_count: number | null;
  target_cohorts: string | null;
}

interface D1WorkerBundlePatchRow {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number | null;
}

interface D1WorkerBundleEventRow {
  id: string;
  kind: string;
  install_id: string;
  active_bundle_id: string;
  previous_active_bundle_id: string | null;
  crashed_bundle_id: string | null;
  platform: "ios" | "android";
  channel: string;
  app_version: string | null;
  fingerprint_hash: string | null;
  cohort: string | null;
  user_id: string | null;
  payload: unknown;
}

function buildWhereClause(
  conditions: QueryConditions | undefined,
): BuildQueryResult {
  if (!conditions) {
    return { sql: "", params: [] };
  }

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (conditions.channel) {
    clauses.push("channel = ?");
    params.push(conditions.channel);
  }

  if (conditions.platform) {
    clauses.push("platform = ?");
    params.push(conditions.platform);
  }

  if (conditions.enabled !== undefined) {
    clauses.push("enabled = ?");
    params.push(conditions.enabled ? 1 : 0);
  }

  if (conditions.id?.in) {
    clauses.push(buildJsonEachInClause("id", conditions.id.in, params));
  }

  if (conditions.id?.eq) {
    clauses.push("id = ?");
    params.push(conditions.id.eq);
  }

  if (conditions.id?.gt) {
    clauses.push("id > ?");
    params.push(conditions.id.gt);
  }

  if (conditions.id?.gte) {
    clauses.push("id >= ?");
    params.push(conditions.id.gte);
  }

  if (conditions.id?.lt) {
    clauses.push("id < ?");
    params.push(conditions.id.lt);
  }

  if (conditions.id?.lte) {
    clauses.push("id <= ?");
    params.push(conditions.id.lte);
  }

  if (conditions.targetAppVersionNotNull) {
    clauses.push("target_app_version IS NOT NULL");
  }

  if (conditions.targetAppVersion !== undefined) {
    if (conditions.targetAppVersion === null) {
      clauses.push("target_app_version IS NULL");
    } else {
      clauses.push("target_app_version = ?");
      params.push(conditions.targetAppVersion);
    }
  }

  if (conditions.targetAppVersionIn) {
    clauses.push(
      buildJsonEachInClause(
        "target_app_version",
        conditions.targetAppVersionIn,
        params,
      ),
    );
  }

  if (conditions.fingerprintHash !== undefined) {
    if (conditions.fingerprintHash === null) {
      clauses.push("fingerprint_hash IS NULL");
    } else {
      clauses.push("fingerprint_hash = ?");
      params.push(conditions.fingerprintHash);
    }
  }

  const whereClause =
    clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

  return { sql: whereClause, params };
}

function parseTargetCohorts(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      return null;
    }
  }
  return null;
}

const parseMetadata = (value: unknown): Bundle["metadata"] => {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return parseMetadata(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Bundle["metadata"])
    : undefined;
};

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId);

const getPatchStringField = (
  patch: DatabaseBundlePatch,
  field: Exclude<
    NonNullable<BundlePatchListQuery["orderBy"]>["field"],
    "orderIndex"
  >,
): string => (field === "id" ? getPatchId(patch) : patch[field]);

const patchMatchesWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
) =>
  !where ||
  ((where.id === undefined || getPatchId(patch) === where.id) &&
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.idIn === undefined || where.idIn.includes(getPatchId(patch))) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId)));

const bundleRecordToRow = (
  bundleRecord: DatabaseBundleRecord,
): D1WorkerBundleRow => {
  const bundle = toBundleReadModel(bundleRecord);
  return {
    id: bundle.id,
    channel: bundle.channel,
    enabled: bundle.enabled ? 1 : 0,
    should_force_update: bundle.shouldForceUpdate ? 1 : 0,
    file_hash: bundle.fileHash,
    git_commit_hash: bundle.gitCommitHash ?? null,
    message: bundle.message ?? null,
    platform: bundle.platform,
    target_app_version: bundle.targetAppVersion,
    storage_uri: bundle.storageUri,
    fingerprint_hash: bundle.fingerprintHash,
    metadata: JSON.stringify(
      stripBundleArtifactMetadata(bundle.metadata) ?? {},
    ),
    manifest_storage_uri: getManifestStorageUri(bundle),
    manifest_file_hash: getManifestFileHash(bundle),
    asset_base_storage_uri: getAssetBaseStorageUri(bundle),
    rollout_cohort_count:
      bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    target_cohorts: bundle.targetCohorts
      ? JSON.stringify(bundle.targetCohorts)
      : null,
  };
};

const databaseBundlePatchToRow = (
  patch: DatabaseBundlePatch,
): D1WorkerBundlePatchRow => ({
  id: patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId),
  bundle_id: patch.bundleId,
  base_bundle_id: patch.baseBundleId,
  base_file_hash: patch.baseFileHash,
  patch_file_hash: patch.patchFileHash,
  patch_storage_uri: patch.patchStorageUri,
  order_index: patch.orderIndex,
});

const rowToDatabaseBundlePatch = (
  row: D1WorkerBundlePatchRow,
): DatabaseBundlePatch => ({
  id: row.id,
  bundleId: row.bundle_id,
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
  orderIndex: row.order_index ?? 0,
});

const toPatchUpdateSql = (
  patch: DatabaseBundlePatchUpdate,
): {
  readonly assignments: readonly string[];
  readonly values: readonly unknown[];
} => {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (patch.baseFileHash !== undefined) {
    assignments.push("base_file_hash = ?");
    values.push(patch.baseFileHash);
  }
  if (patch.patchFileHash !== undefined) {
    assignments.push("patch_file_hash = ?");
    values.push(patch.patchFileHash);
  }
  if (patch.patchStorageUri !== undefined) {
    assignments.push("patch_storage_uri = ?");
    values.push(patch.patchStorageUri);
  }
  if (patch.orderIndex !== undefined) {
    assignments.push("order_index = ?");
    values.push(patch.orderIndex);
  }
  return { assignments, values };
};

const isAppReadyPayload = (value: unknown): value is BundleEventPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<Record<keyof BundleEventPayload, unknown>>;
  return (
    (payload.status === "STABLE" || payload.status === "RECOVERED") &&
    typeof payload.sdkVersion === "string" &&
    typeof payload.defaultChannel === "string" &&
    typeof payload.isChannelSwitched === "boolean"
  );
};

const parseEventPayload = (value: unknown): BundleEventPayload => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isAppReadyPayload(parsed)) {
    throw new Error("Invalid bundle event payload.");
  }
  return parsed;
};

const rowToDatabaseBundleEvent = (
  row: D1WorkerBundleEventRow,
): DatabaseBundleEvent => {
  if (row.kind !== "APP_READY") {
    throw new Error(`Unsupported bundle event kind: ${row.kind}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    installId: row.install_id,
    activeBundleId: row.active_bundle_id,
    previousActiveBundleId: row.previous_active_bundle_id,
    crashedBundleId: row.crashed_bundle_id,
    platform: row.platform,
    channel: row.channel,
    appVersion: row.app_version,
    fingerprintHash: row.fingerprint_hash,
    cohort: row.cohort,
    userId: row.user_id,
    payload: parseEventPayload(row.payload),
  };
};

const eventMatchesWhere = (
  event: DatabaseBundleEvent,
  where: BundleEventListQuery["where"] | undefined,
) =>
  !where ||
  ((where.kind === undefined || event.kind === where.kind) &&
    (where.installId === undefined || event.installId === where.installId) &&
    (where.activeBundleId === undefined ||
      event.activeBundleId === where.activeBundleId) &&
    (where.previousActiveBundleId === undefined ||
      event.previousActiveBundleId === where.previousActiveBundleId) &&
    (where.crashedBundleId === undefined ||
      event.crashedBundleId === where.crashedBundleId) &&
    (where.platform === undefined || event.platform === where.platform) &&
    (where.channel === undefined || event.channel === where.channel) &&
    (where.appVersion === undefined || event.appVersion === where.appVersion) &&
    (where.fingerprintHash === undefined ||
      event.fingerprintHash === where.fingerprintHash) &&
    (where.cohort === undefined || event.cohort === where.cohort) &&
    (where.userId === undefined || event.userId === where.userId));

function transformRowToBundle(
  row: D1WorkerBundleRow,
  patchRows: D1WorkerBundlePatchRow[] = [],
): Bundle {
  const rawMetadata = parseMetadata(row.metadata);
  const patches = patchRows
    .slice()
    .sort(
      (left, right) =>
        (left.order_index ?? 0) - (right.order_index ?? 0) ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map((patch) => ({
      baseBundleId: patch.base_bundle_id,
      baseFileHash: patch.base_file_hash,
      patchFileHash: patch.patch_file_hash,
      patchStorageUri: patch.patch_storage_uri,
    }));
  const primaryPatch = patches[0] ?? null;

  return {
    id: row.id,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    shouldForceUpdate: Boolean(row.should_force_update),
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash,
    message: row.message,
    platform: row.platform,
    targetAppVersion: row.target_app_version,
    storageUri: row.storage_uri,
    fingerprintHash: row.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: row.manifest_storage_uri ?? null,
    manifestFileHash: row.manifest_file_hash ?? null,
    assetBaseStorageUri: row.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount:
      (row.rollout_cohort_count as number | null) ??
      DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: parseTargetCohorts(row.target_cohorts as unknown),
  };
}

const rowToDatabaseBundleRecord = (
  row: D1WorkerBundleRow,
): DatabaseBundleRecord =>
  toDatabaseBundleRecord(transformRowToBundle(row, []));

const paginateItems = <TItem>({
  cursor,
  getCursor,
  items,
  limit,
  page,
}: {
  readonly cursor?: { readonly after?: string; readonly before?: string };
  readonly getCursor: (item: TItem) => string;
  readonly items: readonly TItem[];
  readonly limit: number;
  readonly page?: number;
}): CursorPage<TItem> => {
  const total = items.length;
  const pageOffset = page ? (Math.max(1, page) - 1) * limit : undefined;
  let startIndex =
    pageOffset === undefined ? 0 : Math.min(pageOffset, Math.max(0, total));
  let endIndex = limit > 0 ? startIndex + limit : total;

  if (pageOffset === undefined && cursor?.after) {
    const afterIndex = items.findIndex(
      (item) => getCursor(item) === cursor.after,
    );
    startIndex = afterIndex >= 0 ? afterIndex + 1 : total;
    endIndex = limit > 0 ? startIndex + limit : total;
  } else if (pageOffset === undefined && cursor?.before) {
    const beforeIndex = items.findIndex(
      (item) => getCursor(item) === cursor.before,
    );
    endIndex = beforeIndex >= 0 ? beforeIndex : 0;
    startIndex = limit > 0 ? Math.max(0, endIndex - limit) : 0;
  }

  const data = items.slice(startIndex, endIndex);
  const pagination = calculatePagination(total, {
    limit,
    offset: startIndex,
  });

  return {
    data,
    pagination: {
      ...pagination,
      nextCursor:
        data.length > 0 && startIndex + data.length < total
          ? getCursor(data[data.length - 1]!)
          : null,
      previousCursor:
        data.length > 0 && startIndex > 0 ? getCursor(data[0]!) : null,
    },
  };
};

const resolveDbFromContext = (
  context?: RequestEnvContext<CloudflareWorkerDatabaseEnv>,
) => {
  const db = context?.env?.DB;

  if (!db) {
    throw new Error(
      "d1WorkerDatabase requires env.DB in the hot updater context.",
    );
  }

  return db;
};

const createD1WorkerPlugin = createDatabasePlugin({
  name: "d1WorkerDatabase",
  connect: (db: D1Like): DatabasePluginCore => {
    const queryAll = async <TRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<TRow[]> => {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<TRow>();
      return result.results ?? [];
    };

    const queryFirst = async <TRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<TRow | null> => {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .first<TRow>();
      return result ?? null;
    };

    const run = async (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<void> => {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    };

    const getPatchMap = async (bundleIds: string[]) => {
      const patchMap = new Map<string, D1WorkerBundlePatchRow[]>();
      if (bundleIds.length === 0) return patchMap;

      const rows = await queryAll<D1WorkerBundlePatchRow>(
        `
          SELECT *
          FROM bundle_patches
          WHERE bundle_id IN (SELECT value FROM json_each(?))
          ORDER BY order_index ASC, base_bundle_id ASC
        `,
        [JSON.stringify(bundleIds)],
      );

      for (const row of rows) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }

      return patchMap;
    };

    const getBundleById = async (
      bundleId: string,
    ): Promise<DatabaseBundleRecord | null> => {
      const row = await queryFirst<D1WorkerBundleRow>(
        "SELECT * FROM bundles WHERE id = ? LIMIT 1",
        [bundleId],
      );
      return row ? rowToDatabaseBundleRecord(row) : null;
    };

    const queryBundleRows = async (
      conditions: QueryConditions | undefined,
      orderBy?: DatabaseBundleQueryOrder,
    ): Promise<D1WorkerBundleRow[]> => {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const orderSql =
        orderBy?.direction === "asc" ? "ORDER BY id ASC" : "ORDER BY id DESC";
      return queryAll<D1WorkerBundleRow>(
        `SELECT * FROM bundles${whereClause} ${orderSql}`,
        params,
      );
    };

    const queryBundlesForUpdateInfo = async (
      conditions: QueryConditions,
    ): Promise<Bundle[]> => {
      const rows = await queryBundleRows(conditions, {
        field: "id",
        direction: "desc",
      });
      const patchMap = await getPatchMap(rows.map((row) => row.id));
      return rows.map((row) => transformRowToBundle(row, patchMap.get(row.id)));
    };

    const getTargetAppVersionsForUpdateInfo = async ({
      platform,
      channel,
      minBundleId,
    }: {
      platform: Bundle["platform"];
      channel: string;
      minBundleId: string;
    }): Promise<string[]> => {
      const rows = await queryAll<{ target_app_version: string }>(
        `
          SELECT target_app_version
          FROM bundles
          WHERE channel = ?
            AND platform = ?
            AND enabled = 1
            AND id >= ?
            AND target_app_version IS NOT NULL
          GROUP BY target_app_version
        `,
        [channel, platform, minBundleId],
      );

      return rows.map((row) => row.target_app_version);
    };

    const persistBundle = async (bundle: DatabaseBundleRecord) => {
      const row = bundleRecordToRow(bundle);
      await run(
        `
          INSERT OR REPLACE INTO bundles (
            id,
            channel,
            enabled,
            should_force_update,
            file_hash,
            git_commit_hash,
            message,
            platform,
            target_app_version,
            storage_uri,
            fingerprint_hash,
            metadata,
            manifest_storage_uri,
            manifest_file_hash,
            asset_base_storage_uri,
            rollout_cohort_count,
            target_cohorts
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          row.id,
          row.channel,
          row.enabled,
          row.should_force_update,
          row.file_hash,
          row.git_commit_hash,
          row.message,
          row.platform,
          row.target_app_version,
          row.storage_uri,
          row.fingerprint_hash,
          row.metadata,
          row.manifest_storage_uri,
          row.manifest_file_hash,
          row.asset_base_storage_uri,
          row.rollout_cohort_count,
          row.target_cohorts,
        ],
      );
    };

    const persistPatch = async (patch: DatabaseBundlePatch) => {
      const patchRow = databaseBundlePatchToRow(patch);
      await run(
        `
          INSERT OR REPLACE INTO bundle_patches (
            id,
            bundle_id,
            base_bundle_id,
            base_file_hash,
            patch_file_hash,
            patch_storage_uri,
            order_index
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          patchRow.id,
          patchRow.bundle_id,
          patchRow.base_bundle_id,
          patchRow.base_file_hash,
          patchRow.patch_file_hash,
          patchRow.patch_storage_uri,
          patchRow.order_index ?? 0,
        ],
      );
    };

    return {
      bundles: {
        async getById({ bundleId }) {
          return getBundleById(bundleId);
        },
        async findMany({ where, orderBy, window }) {
          const rows = await queryBundleRows(where, orderBy);
          return rows
            .slice(window.offset, window.offset + window.limit)
            .map(rowToDatabaseBundleRecord);
        },
        async count({ where }) {
          const rows = await queryBundleRows(where);
          return rows.length;
        },
        async insert({ bundle }) {
          await persistBundle(bundle);
        },
        async update({ bundleId, patch }) {
          const current = await getBundleById(bundleId);
          if (!current) throw new Error("targetBundleId not found");
          await persistBundle({ ...current, ...patch, id: bundleId });
        },
        async delete({ bundleId }) {
          await run("DELETE FROM bundles WHERE id = ?", [bundleId]);
        },
      },
      bundlePatches: {
        async findMany({ where, orderBy, window }) {
          const rows = await queryAll<D1WorkerBundlePatchRow>(
            "SELECT * FROM bundle_patches ORDER BY order_index ASC",
          );
          const patches = rows
            .map(rowToDatabaseBundlePatch)
            .filter((patch) => patchMatchesWhere(patch, where))
            .sort((left, right) => {
              const field = orderBy?.field ?? "orderIndex";
              const direction = orderBy?.direction ?? "asc";
              const result =
                field === "orderIndex"
                  ? left.orderIndex - right.orderIndex ||
                    getPatchId(left).localeCompare(getPatchId(right))
                  : getPatchStringField(left, field).localeCompare(
                      getPatchStringField(right, field),
                    );
              return direction === "asc" ? result : -result;
            });
          return patches.slice(window.offset, window.offset + window.limit);
        },
        async count({ where }) {
          const rows = await queryAll<D1WorkerBundlePatchRow>(
            "SELECT * FROM bundle_patches ORDER BY order_index ASC",
          );
          return rows
            .map(rowToDatabaseBundlePatch)
            .filter((patch) => patchMatchesWhere(patch, where)).length;
        },
        async getById({ patchId }) {
          const row = await queryFirst<D1WorkerBundlePatchRow>(
            "SELECT * FROM bundle_patches WHERE id = ?",
            [patchId],
          );
          return row ? rowToDatabaseBundlePatch(row) : null;
        },
        async insert({ patch }) {
          await persistPatch(patch);
        },
        async update({ patchId, patch }) {
          const update = toPatchUpdateSql(patch);
          if (update.assignments.length === 0) return;
          await run(
            `UPDATE bundle_patches SET ${update.assignments.join(", ")} WHERE id = ?`,
            [...update.values, patchId],
          );
        },
        async delete({ patchId }) {
          await run("DELETE FROM bundle_patches WHERE id = ?", [patchId]);
        },
      },
      bundleEvents: {
        async list(options: BundleEventListQuery) {
          const direction = options.orderBy?.direction ?? "desc";
          const rows = await queryAll<D1WorkerBundleEventRow>(
            `SELECT * FROM bundle_events ORDER BY id ${direction}`,
          );
          const events = rows
            .map(rowToDatabaseBundleEvent)
            .filter((event) => eventMatchesWhere(event, options.where));
          return paginateItems({
            items: events,
            limit: options.limit,
            cursor: options.cursor,
            getCursor: (event) => event.id,
          });
        },
        async append({ event }) {
          await run(
            `
              INSERT INTO bundle_events (
                id,
                kind,
                install_id,
                active_bundle_id,
                previous_active_bundle_id,
                crashed_bundle_id,
                platform,
                channel,
                app_version,
                fingerprint_hash,
                cohort,
                user_id,
                payload
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              event.id,
              event.kind,
              event.installId,
              event.activeBundleId,
              event.previousActiveBundleId ?? null,
              event.crashedBundleId ?? null,
              event.platform,
              event.channel,
              event.appVersion ?? null,
              event.fingerprintHash ?? null,
              event.cohort ?? null,
              event.userId ?? null,
              JSON.stringify(event.payload),
            ],
          );
        },
      },
      updateInfo: {
        async get(args) {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;

          if (args._updateStrategy === "appVersion") {
            const targetAppVersions = await getTargetAppVersionsForUpdateInfo({
              platform: args.platform,
              channel,
              minBundleId,
            });
            const compatibleAppVersions = filterCompatibleAppVersions(
              targetAppVersions,
              args.appVersion,
            );
            const bundles =
              compatibleAppVersions.length > 0
                ? await queryBundlesForUpdateInfo({
                    enabled: true,
                    platform: args.platform,
                    channel,
                    id: { gte: minBundleId },
                    targetAppVersionIn: compatibleAppVersions,
                  })
                : [];

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles,
            });
          }

          const bundles = await queryBundlesForUpdateInfo({
            enabled: true,
            platform: args.platform,
            channel,
            id: { gte: minBundleId },
            fingerprintHash: args.fingerprintHash,
          });

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles,
          });
        },
      },
    };
  },
});

export const d1WorkerDatabase = <
  TContext extends RequestEnvContext<CloudflareWorkerDatabaseEnv> =
    RequestEnvContext<CloudflareWorkerDatabaseEnv>,
>() =>
  markDatabaseRuntimeOpener<TContext>((context) =>
    createD1WorkerPlugin(resolveDbFromContext(context)),
  );
