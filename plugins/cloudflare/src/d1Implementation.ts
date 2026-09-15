import type {
  BundlePatchRow,
  BundleRow,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  ChannelDeleteInput,
  ChannelDeleteResult,
  DatabaseChange,
  DatabaseCommit,
  DatabaseCommitExpectation,
  DatabaseCommitResult,
} from "@hot-updater/plugin-core";
import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
  latestInsightsWhere,
  latestInsightsCountGroups,
  recordProjectedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import type {
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  InsightsProjectionBackend,
  PreparedInsightsEvent,
  ReleaseReference,
  UpdateDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";

import { countD1Rows, d1TableNames, findManyD1Rows } from "./d1Query";
import { parseD1Row } from "./d1Rows";
import { buildD1Where, d1Placeholders, encodeD1Values } from "./d1Sql";

export interface D1Executor {
  query(sql: string, params: readonly string[]): Promise<readonly unknown[]>;
  batch(
    statements: readonly D1Statement[],
  ): Promise<readonly (readonly unknown[])[]>;
}

export interface D1Statement {
  readonly sql: string;
  readonly params: readonly string[];
}

export class D1ExecutionError extends Error {
  readonly name = "D1ExecutionError";
  constructor() {
    super("D1 did not successfully execute every requested statement");
  }
}

type D1Guard = {
  readonly sql: string;
  readonly params: readonly string[];
};

const EXPECTATION_CONFLICT_MARKER = "HOT_UPDATER_COMMIT_EXPECTATION_CONFLICT";
const INSIGHTS_CONFLICT_MARKER = "HOT_UPDATER_INSIGHTS_CONFLICT";

const expectationGuard = (
  expectations: readonly DatabaseCommitExpectation[],
): D1Guard => {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const expectation of expectations) {
    const isRelease = expectation.model === "releases";
    const table = isRelease ? "releases" : "release_catalogs";
    const keyField = isRelease ? "id" : "scope_key";
    const versionField = isRelease ? "revision" : "generation";
    const key = isRelease ? expectation.id : expectation.scopeKey;
    const version = isRelease ? expectation.revision : expectation.generation;
    if (version === null) {
      clauses.push(
        `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${keyField} = json_extract(?, '$'))`,
      );
      params.push(...encodeD1Values([key]));
    } else {
      clauses.push(
        `EXISTS (SELECT 1 FROM ${table} WHERE ${keyField} = json_extract(?, '$') AND ${versionField} = json_extract(?, '$'))`,
      );
      params.push(...encodeD1Values([key, version]));
    }
  }
  return { sql: clauses.join(" AND ") || "1", params };
};

const readVersion = (
  row: unknown,
  field: "generation" | "revision",
): number | null => {
  if (typeof row !== "object" || row === null) return null;
  const value = Reflect.get(row, field);
  return typeof value === "number" ? value : null;
};

const expectationConflict = async (
  executor: D1Executor,
  expectations: readonly DatabaseCommitExpectation[],
): Promise<DatabaseCommitResult | null> => {
  for (const expectation of expectations) {
    const isRelease = expectation.model === "releases";
    const table = isRelease ? "releases" : "release_catalogs";
    const keyField = isRelease ? "id" : "scope_key";
    const versionField = isRelease ? "revision" : "generation";
    const key = isRelease ? expectation.id : expectation.scopeKey;
    const expectedVersion = isRelease
      ? expectation.revision
      : expectation.generation;
    const rows = await executor.query(
      `SELECT ${versionField} FROM ${table} WHERE ${keyField} = json_extract(?, '$') LIMIT 1`,
      encodeD1Values([key]),
    );
    const actualVersion = readVersion(rows[0], versionField);
    if (actualVersion !== expectedVersion) {
      return {
        committed: false,
        conflict: {
          actualVersion,
          changeIndex: -1,
          expectedVersion,
          key,
          model: expectation.model,
          reason: "version_conflict",
        },
      };
    }
  }
  return null;
};

const isExpectationConflictError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(EXPECTATION_CONFLICT_MARKER) ||
    message.toLowerCase().includes("malformed json")
  );
};

const bundleValues = (row: BundleRow): readonly unknown[] => [
  row.id,
  row.platform,
  row.file_hash,
  row.git_commit_hash,
  row.storage_uri,
  row.archive_byte_size,
  row.metadata,
  row.manifest_storage_uri,
  row.manifest_file_hash,
  row.asset_base_storage_uri,
];

const patchValues = (row: BundlePatchRow): readonly unknown[] => [
  row.id,
  row.bundle_id,
  row.base_bundle_id,
  row.base_file_hash,
  row.patch_file_hash,
  row.patch_storage_uri,
  row.byte_size,
  row.order_index,
];

const channelValues = (row: ChannelRow): readonly unknown[] => [
  row.id,
  row.name,
];

const insertQuery = (
  input: CreateDatabaseImplementationInput,
  guard?: D1Guard,
  conflictMode: "returnExisting" | "ignore" = "returnExisting",
): D1Statement => {
  let columns: readonly string[];
  let values: readonly unknown[];
  switch (input.model) {
    case "bundles":
      columns = [
        "id",
        "platform",
        "file_hash",
        "git_commit_hash",
        "storage_uri",
        "archive_byte_size",
        "metadata",
        "manifest_storage_uri",
        "manifest_file_hash",
        "asset_base_storage_uri",
      ];
      values = bundleValues(input.data);
      break;
    case "bundle_patches":
      columns = [
        "id",
        "bundle_id",
        "base_bundle_id",
        "base_file_hash",
        "patch_file_hash",
        "patch_storage_uri",
        "byte_size",
        "order_index",
      ];
      values = patchValues(input.data);
      break;
    case "channels":
      columns = ["id", "name"];
      values = channelValues(input.data);
      break;
    case "bundle_events":

    case "api_keys":
    case "release_catalogs":
    case "releases":
      columns = Object.keys(input.data);
      values = Object.values(input.data);
      break;
  }

  const conflict =
    input.onConflict !== "ignore"
      ? ""
      : input.model === "channels"
        ? conflictMode === "ignore"
          ? " ON CONFLICT(name) DO NOTHING"
          : " ON CONFLICT(name) DO UPDATE SET name = excluded.name"
        : input.model === "api_keys"
          ? conflictMode === "ignore"
            ? " ON CONFLICT(hash) DO NOTHING"
            : " ON CONFLICT(hash) DO UPDATE SET hash = excluded.hash"
          : " ON CONFLICT(install_id) DO UPDATE SET install_id = excluded.install_id";

  return {
    sql: `INSERT INTO ${d1TableNames[input.model]} (${columns.join(", ")}) ${
      guard === undefined
        ? `VALUES (${d1Placeholders(values.length)})`
        : `SELECT ${d1Placeholders(values.length)} WHERE ${guard.sql}`
    }${conflict} RETURNING *`,
    params: [...encodeD1Values(values), ...(guard?.params ?? [])],
  };
};

const updateEntries = (
  update: UpdateDatabaseImplementationInput["update"],
): readonly [string, unknown][] => Object.entries(update);

const updateQuery = (
  input: UpdateDatabaseImplementationInput,
  guard?: D1Guard,
): D1Statement => {
  const entries = updateEntries(input.update);
  const where = buildD1Where(input.where);
  if (entries.length === 0) {
    return {
      sql: `SELECT * FROM ${d1TableNames[input.model]}${where.sql}${guard ? ` AND ${guard.sql}` : ""} LIMIT 1`,
      params: [...where.params, ...(guard?.params ?? [])],
    };
  }
  const assignments = entries
    .map(([field]) => `${field} = json_extract(?, '$')`)
    .join(", ");
  return {
    sql: `UPDATE ${d1TableNames[input.model]} SET ${assignments}${where.sql}${guard ? ` AND ${guard.sql}` : ""} RETURNING *`,
    params: [
      ...encodeD1Values(entries.map(([, value]) => value)),
      ...where.params,
      ...(guard?.params ?? []),
    ],
  };
};

const deleteQuery = (
  input: DeleteDatabaseImplementationInput,
  guard?: D1Guard,
): D1Statement => {
  const where = buildD1Where(input.where);
  return {
    sql: `DELETE FROM ${d1TableNames[input.model]}${where.sql}${guard ? ` AND ${guard.sql}` : ""}`,
    params: [...where.params, ...(guard?.params ?? [])],
  };
};

type D1RequiredRow = {
  readonly model: "bundles" | "api_keys" | "releases";
  readonly id: string;
  readonly changeIndex: number;
};

type D1Check = {
  readonly changeIndex: number;
  readonly resultIndex: number;
  readonly conflictWhen: "empty" | "nonempty";
  readonly reason: "not_found" | "referenced";
};

type D1CommitPlan = {
  readonly checks: readonly D1Check[];
  readonly statements: readonly D1Statement[];
};

const insertedKey = (change: DatabaseChange): string | undefined => {
  if (change.operation !== "insert") return undefined;
  if (change.model === "bundles") return `bundles:${change.row.id}`;
  if (change.model === "apiKeys") {
    return `api_keys:${change.row.id}`;
  }
  if (change.model === "releases") {
    return `releases:${change.row.id}`;
  }
  return undefined;
};

const requiredRow = (
  change: DatabaseChange,
  changeIndex: number,
): D1RequiredRow | undefined => {
  if (change.operation !== "update") return undefined;
  if (change.model === "bundles") {
    return {
      model: "bundles",
      id: change.where.id,
      changeIndex,
    };
  }
  if (change.model === "apiKeys") {
    return {
      model: "api_keys",
      id: change.where.id,
      changeIndex,
    };
  }
  if (change.model === "releases") {
    return {
      model: "releases",
      id: change.where.id,
      changeIndex,
    };
  }
  return undefined;
};

type D1ChannelDeletePrecondition = {
  readonly id: string;
  readonly excludedReleaseIds: readonly string[];
  readonly addedReferenceReleaseIds: readonly string[];
};

const channelDeletePrecondition = (
  changes: readonly DatabaseChange[],
  changeIndex: number,
  channelId: string,
): D1ChannelDeletePrecondition => {
  const releaseEffects = new Map<string, string | null>();
  for (const change of changes.slice(0, changeIndex)) {
    if (change.model !== "releases") continue;
    switch (change.operation) {
      case "insert":
        releaseEffects.set(change.row.id, change.row.channel_id);
        break;
      case "update":
        break;
      case "delete":
        releaseEffects.set(change.where.id, null);
        break;
    }
  }
  return {
    id: channelId,
    excludedReleaseIds: [...releaseEffects.keys()],
    addedReferenceReleaseIds: [...releaseEffects]
      .filter(([, finalChannelId]) => finalChannelId === channelId)
      .map(([releaseId]) => releaseId),
  };
};

const changeQuery = (change: DatabaseChange, guard: D1Guard): D1Statement => {
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          return insertQuery({ model: "bundles", data: change.row }, guard);
        case "update":
          return updateQuery(
            {
              model: "bundles",
              where: [{ field: "id", value: change.where.id }],
              update: change.update,
            },
            guard,
          );
        case "delete":
          return deleteQuery(
            {
              model: "bundles",
              where: [{ field: "id", value: change.where.id }],
            },
            guard,
          );
      }
    case "bundlePatches":
      return change.operation === "insert"
        ? insertQuery({ model: "bundle_patches", data: change.row }, guard)
        : deleteQuery(
            {
              model: "bundle_patches",
              where: [{ field: "bundle_id", value: change.where.bundleId }],
            },
            guard,
          );
    case "releases":
      switch (change.operation) {
        case "insert":
          return insertQuery({ model: "releases", data: change.row }, guard);
        case "update":
          return updateQuery(
            {
              model: "releases",
              where: [{ field: "id", value: change.where.id }],
              update: change.update,
            },
            guard,
          );
        case "delete":
          return deleteQuery(
            {
              model: "releases",
              where: [{ field: "id", value: change.where.id }],
            },
            guard,
          );
      }
    case "releaseCatalogs":
      return {
        sql: `INSERT INTO release_catalogs (${Object.keys(change.row).join(", ")}) SELECT ${d1Placeholders(Object.keys(change.row).length)} WHERE ${guard.sql} ON CONFLICT(scope_key) DO UPDATE SET ${Object.keys(
          change.row,
        )
          .filter((field) => field !== "scope_key")
          .map((field) => `${field} = excluded.${field}`)
          .join(", ")} RETURNING *`,
        params: [...encodeD1Values(Object.values(change.row)), ...guard.params],
      };
    case "channels":
      return change.operation === "insert"
        ? insertQuery(
            {
              model: "channels",
              data: change.row,
              onConflict: change.onConflict,
            },
            guard,
            "ignore",
          )
        : {
            sql: `DELETE FROM channels WHERE id = json_extract(?, '$') AND NOT EXISTS (SELECT 1 FROM releases WHERE channel_id = json_extract(?, '$')) AND ${guard.sql}`,
            params: [
              ...encodeD1Values([change.where.id, change.where.id]),
              ...guard.params,
            ],
          };
    case "apiKeys":
      return change.operation === "insert"
        ? insertQuery(
            {
              model: "api_keys",
              data: change.row,
              onConflict: change.onConflict,
            },
            guard,
            "ignore",
          )
        : updateQuery(
            {
              model: "api_keys",
              where: [{ field: "id", value: change.where.id }],
              update: { revoked_at_ms: change.update.revokedAtMs },
            },
            guard,
          );
  }
};

const createCommitPlan = (input: DatabaseCommit): D1CommitPlan => {
  const checks: D1Check[] = [];
  const statements: D1Statement[] = [];
  const expectations = input.expectations ?? [];
  if (expectations.length > 0) {
    const guard = expectationGuard(expectations);
    statements.push({
      sql: `SELECT CASE WHEN ${guard.sql} THEN 1 ELSE json_extract('${EXPECTATION_CONFLICT_MARKER}', '$') END AS expectation_guard`,
      params: guard.params,
    });
  }
  const requiredRows: D1RequiredRow[] = [];
  const channelDeletes: D1ChannelDeletePrecondition[] = [];
  const inserted = new Set<string>();
  for (const [changeIndex, change] of input.changes.entries()) {
    const required = requiredRow(change, changeIndex);
    if (required !== undefined) {
      if (!inserted.has(`${required.model}:${required.id}`)) {
        requiredRows.push(required);
        checks.push({
          changeIndex,
          resultIndex: statements.length,
          conflictWhen: "empty",
          reason: "not_found",
        });
        statements.push({
          sql: `SELECT id FROM ${d1TableNames[required.model]} WHERE id = json_extract(?, '$') LIMIT 1`,
          params: encodeD1Values([required.id]),
        });
      }
    }
    if (change.model === "channels" && change.operation === "delete") {
      const precondition = channelDeletePrecondition(
        input.changes,
        changeIndex,
        change.where.id,
      );
      channelDeletes.push(precondition);
      checks.push({
        changeIndex,
        resultIndex: statements.length,
        conflictWhen: "nonempty",
        reason: "referenced",
      });
      statements.push({
        sql: "SELECT id FROM releases WHERE channel_id = json_extract(?, '$') AND id NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT value AS id FROM json_each(?) LIMIT 1",
        params: encodeD1Values([
          precondition.id,
          precondition.excludedReleaseIds,
          precondition.addedReferenceReleaseIds,
        ]),
      });
    }
    const key = insertedKey(change);
    if (key !== undefined) inserted.add(key);
  }

  const guard: D1Guard = {
    sql: `NOT EXISTS (
      SELECT 1 FROM json_each(?) AS required
      WHERE NOT EXISTS (
        SELECT 1 FROM bundles
        WHERE json_extract(required.value, '$.model') = 'bundles'
          AND bundles.id = json_extract(required.value, '$.id')
        UNION ALL
        SELECT 1 FROM api_keys
        WHERE json_extract(required.value, '$.model') = 'api_keys'
          AND api_keys.id = json_extract(required.value, '$.id')
        UNION ALL
        SELECT 1 FROM channels
        WHERE json_extract(required.value, '$.model') = 'channels'
          AND channels.id = json_extract(required.value, '$.id')
        UNION ALL
        SELECT 1 FROM releases
        WHERE json_extract(required.value, '$.model') = 'releases'
          AND releases.id = json_extract(required.value, '$.id')
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM json_each(?) AS channel_delete
      WHERE EXISTS (
        SELECT 1 FROM releases
        WHERE releases.channel_id = json_extract(channel_delete.value, '$.id')
          AND releases.id NOT IN (
            SELECT value FROM json_each(
              json_extract(channel_delete.value, '$.excludedReleaseIds')
            )
          )
        UNION ALL
        SELECT value FROM json_each(
          json_extract(channel_delete.value, '$.addedReferenceReleaseIds')
        )
      )
    )`,
    params: encodeD1Values([
      requiredRows.map(({ model, id }) => ({ model, id })),
      channelDeletes,
    ]),
  };

  statements.push(...input.changes.map((change) => changeQuery(change, guard)));
  return { checks, statements };
};

const resultForPlan = (
  plan: D1CommitPlan,
  results: readonly (readonly unknown[])[],
): DatabaseCommitResult => {
  const missing = plan.checks.find(({ conflictWhen, resultIndex }) =>
    conflictWhen === "empty"
      ? (results[resultIndex]?.length ?? 0) === 0
      : (results[resultIndex]?.length ?? 0) > 0,
  );
  return missing === undefined
    ? { committed: true }
    : {
        committed: false,
        conflict: {
          changeIndex: missing.changeIndex,
          reason: missing.reason,
        },
      };
};

const insertChannel = async (
  executor: D1Executor,
  input: ChannelInsertInput,
): Promise<ChannelInsertResult> => {
  const insert = insertQuery(
    { model: "channels", data: input.row, onConflict: "ignore" },
    undefined,
    "ignore",
  );
  const select = {
    sql: "SELECT id, name FROM channels WHERE name = json_extract(?, '$') LIMIT 1",
    params: encodeD1Values([input.row.name]),
  };
  const [insertedRows = [], canonicalRows = []] = await executor.batch([
    insert,
    select,
  ]);
  return {
    row: parseD1Row("channels", canonicalRows[0]),
    inserted: insertedRows.length > 0,
  };
};

const deleteChannel = async (
  executor: D1Executor,
  input: ChannelDeleteInput,
): Promise<ChannelDeleteResult> => {
  const [channelRows = [], referenceRows = [], deletedRows = []] =
    await executor.batch([
      {
        sql: "SELECT id FROM channels WHERE id = json_extract(?, '$') LIMIT 1",
        params: encodeD1Values([input.id]),
      },
      {
        sql: "SELECT id FROM releases WHERE channel_id = json_extract(?, '$') LIMIT 1",
        params: encodeD1Values([input.id]),
      },
      {
        sql: "DELETE FROM channels WHERE id = json_extract(?, '$') AND NOT EXISTS (SELECT 1 FROM releases WHERE channel_id = json_extract(?, '$')) RETURNING id",
        params: encodeD1Values([input.id, input.id]),
      },
    ]);
  if (channelRows.length === 0) return { deleted: false, reason: "not_found" };
  if (referenceRows.length > 0) return { deleted: false, reason: "not_empty" };
  return deletedRows.length > 0
    ? { deleted: true }
    : { deleted: false, reason: "not_empty" };
};

const d1Number = (row: unknown, field: string): number => {
  const value =
    typeof row === "object" && row !== null
      ? Reflect.get(row, field)
      : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid D1 Insights ${field}.`);
  }
  return value;
};

const summaryStatement = (
  release: ReleaseReference,
  values: readonly [number, number, number, number],
): readonly D1Statement[] => [
  {
    sql: `INSERT INTO insights_release_summaries
    (release_key, release_id, platform, channel, active_installations, pending_installations, downloaded_installations, recovered_installations)
VALUES (json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), 0, 0, 0, 0)
ON CONFLICT(release_key) DO NOTHING`,
    params: encodeD1Values([
      insightsReleaseKey(release),
      release.releaseId,
      release.platform,
      release.channel,
    ]),
  },
  {
    sql: `UPDATE insights_release_summaries SET
  active_installations = active_installations + json_extract(?, '$'),
  pending_installations = pending_installations + json_extract(?, '$'),
  downloaded_installations = downloaded_installations + json_extract(?, '$'),
  recovered_installations = recovered_installations + json_extract(?, '$')
WHERE release_key = json_extract(?, '$')`,
    params: encodeD1Values([...values, insightsReleaseKey(release)]),
  },
];

const d1ProjectionStatements = (
  prepared: PreparedInsightsEvent,
): readonly D1Statement[] => {
  const statements: D1Statement[] = [];
  for (const delta of prepared.summaryDeltas) {
    statements.push(
      ...summaryStatement(delta.release, [
        delta.active,
        delta.pending,
        delta.downloaded,
        delta.recovered,
      ]),
    );
  }
  if (prepared.firstLifetime !== null) {
    const key = prepared.firstLifetime;
    statements.push({
      sql: `INSERT INTO insights_lifetime_markers
          (marker_key, release_id, platform, channel, install_id, metric)
VALUES (json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'))`,
      params: encodeD1Values([
        insightsLifetimeMarkerKey(key),
        key.release.releaseId,
        key.release.platform,
        key.release.channel,
        key.installId,
        key.metric,
      ]),
    });
  }
  if (prepared.hourly !== null) {
    const hourly = prepared.hourly;
    statements.push({
      sql: `INSERT INTO insights_hourly_activity
        (bucket_key, release_id, platform, channel, hour_start_ms, downloaded_reports, applied_reports, recovered_reports)
VALUES (json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'))
ON CONFLICT(bucket_key) DO UPDATE SET
  downloaded_reports = downloaded_reports + excluded.downloaded_reports,
  applied_reports = applied_reports + excluded.applied_reports,
  recovered_reports = recovered_reports + excluded.recovered_reports`,
      params: encodeD1Values([
        insightsHourlyBucketKey(hourly.release, hourly.hourStartMs),
        hourly.release.releaseId,
        hourly.release.platform,
        hourly.release.channel,
        hourly.hourStartMs,
        hourly.metric === "downloaded" ? 1 : 0,
        hourly.metric === "applied" ? 1 : 0,
        hourly.metric === "recovered" ? 1 : 0,
      ]),
    });
  }
  return statements;
};

export const createD1Implementation = (
  executor: D1Executor,
): DatabasePluginImplementation => {
  const releaseActivityProjection: InsightsProjectionBackend = {
    async readRecordContext({ installId, lifetimeKey }) {
      const [states = [], markers = []] = await executor.batch([
        {
          sql: "SELECT revision, state FROM insights_install_states WHERE install_id = json_extract(?, '$') LIMIT 1",
          params: encodeD1Values([installId]),
        },
        lifetimeKey === null
          ? { sql: "SELECT 1 WHERE 0", params: [] }
          : {
              sql: "SELECT marker_key FROM insights_lifetime_markers WHERE marker_key = json_extract(?, '$') LIMIT 1",
              params: encodeD1Values([insightsLifetimeMarkerKey(lifetimeKey)]),
            },
      ]);
      const state = states[0];
      if (state === undefined) {
        return {
          revision: "0",
          state: null,
          lifetimeExists: markers.length > 0,
        };
      }
      const revision = d1Number(state, "revision");
      const serialized = Reflect.get(state as object, "state");
      if (typeof serialized !== "string") {
        throw new Error("Invalid D1 Insights projection state.");
      }
      return {
        revision: String(revision),
        state: serialized,
        lifetimeExists: markers.length > 0,
      };
    },
    async commitPreparedEvent(prepared) {
      const existing = await executor.query(
        "SELECT id FROM bundle_events WHERE id = json_extract(?, '$') LIMIT 1",
        encodeD1Values([prepared.event.id]),
      );
      if (existing.length > 0) return { status: "duplicate" };
      const expected = Number(prepared.expectedRevision);
      if (!Number.isSafeInteger(expected) || expected < 0) {
        throw new Error("Invalid D1 Insights revision.");
      }
      const stateGuard =
        expected === 0
          ? "NOT EXISTS (SELECT 1 FROM insights_install_states WHERE install_id = json_extract(?, '$'))"
          : "EXISTS (SELECT 1 FROM insights_install_states WHERE install_id = json_extract(?, '$') AND revision = json_extract(?, '$'))";
      const stateGuardParams = encodeD1Values(
        expected === 0
          ? [prepared.event.install_id]
          : [prepared.event.install_id, expected],
      );
      const markerGuard =
        prepared.firstLifetime === null
          ? { sql: "1", params: [] as string[] }
          : {
              sql: "NOT EXISTS (SELECT 1 FROM insights_lifetime_markers WHERE marker_key = json_extract(?, '$'))",
              params: encodeD1Values([
                insightsLifetimeMarkerKey(prepared.firstLifetime),
              ]),
            };
      const eventInsert = insertQuery({
        model: "bundle_events",
        data: prepared.event,
      });
      const statements: D1Statement[] = [
        {
          sql: `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM bundle_events WHERE id = json_extract(?, '$')) AND ${stateGuard} AND ${markerGuard.sql} THEN 1 ELSE json_extract('${INSIGHTS_CONFLICT_MARKER}', '$') END AS insights_guard`,
          params: [
            ...encodeD1Values([prepared.event.id]),
            ...stateGuardParams,
            ...markerGuard.params,
          ],
        },
        ...d1ProjectionStatements(prepared),
        { sql: eventInsert.sql, params: eventInsert.params },
        {
          sql: `INSERT INTO bundle_event_heads (install_id, id, received_at_ms, user_id, platform, channel, type, from_bundle_id, to_bundle_id)
SELECT install_id, id, received_at_ms, user_id, platform, channel, type, from_bundle_id, to_bundle_id
FROM bundle_events WHERE id = json_extract(?, '$')
ON CONFLICT(install_id) DO UPDATE SET
  id = excluded.id, received_at_ms = excluded.received_at_ms, user_id = excluded.user_id,
  platform = excluded.platform, channel = excluded.channel, type = excluded.type,
  from_bundle_id = excluded.from_bundle_id, to_bundle_id = excluded.to_bundle_id
WHERE (excluded.received_at_ms, excluded.id) > (bundle_event_heads.received_at_ms, bundle_event_heads.id)`,
          params: encodeD1Values([prepared.event.id]),
        },
        {
          sql: `INSERT INTO insights_install_states (install_id, revision, state)
VALUES (json_extract(?, '$'), 1, json_extract(?, '$'))
ON CONFLICT(install_id) DO UPDATE SET revision = revision + 1, state = excluded.state`,
          params: encodeD1Values([
            prepared.event.install_id,
            prepared.nextState,
          ]),
        },
      ];
      try {
        await executor.batch(statements);
        return { status: "committed" };
      } catch (error) {
        const accepted = await executor.query(
          "SELECT id FROM bundle_events WHERE id = json_extract(?, '$') LIMIT 1",
          encodeD1Values([prepared.event.id]),
        );
        if (accepted.length > 0) return { status: "duplicate" };
        const [states = [], markers = []] = await executor.batch([
          {
            sql: "SELECT revision FROM insights_install_states WHERE install_id = json_extract(?, '$') LIMIT 1",
            params: encodeD1Values([prepared.event.install_id]),
          },
          prepared.firstLifetime === null
            ? { sql: "SELECT 1 WHERE 0", params: [] }
            : {
                sql: "SELECT marker_key FROM insights_lifetime_markers WHERE marker_key = json_extract(?, '$') LIMIT 1",
                params: encodeD1Values([
                  insightsLifetimeMarkerKey(prepared.firstLifetime),
                ]),
              },
        ]);
        const actualRevision =
          states[0] === undefined ? 0 : d1Number(states[0], "revision");
        if (
          String(actualRevision) !== prepared.expectedRevision ||
          markers.length > 0
        ) {
          return { status: "conflict" };
        }
        throw error;
      }
    },
    async getReleaseActivity(input) {
      const keys = input.releases.map(insightsReleaseKey);
      const summaries = await executor.query(
        "SELECT * FROM insights_release_summaries WHERE release_key IN (SELECT value FROM json_each(?))",
        encodeD1Values([keys]),
      );
      const summaryByKey = new Map(
        summaries.map((row) => [
          Reflect.get(row as object, "release_key"),
          row,
        ]),
      );
      const hourly =
        input.timeRange === undefined
          ? []
          : await executor.query(
              `SELECT * FROM insights_hourly_activity
WHERE (${input.releases
                .map(
                  () =>
                    "(platform = json_extract(?, '$') AND channel = json_extract(?, '$') AND release_id = json_extract(?, '$'))",
                )
                .join(" OR ")})
  AND hour_start_ms >= json_extract(?, '$')
  AND hour_start_ms < json_extract(?, '$')
ORDER BY platform ASC, channel ASC, release_id ASC, hour_start_ms ASC`,
              encodeD1Values([
                ...input.releases.flatMap((release) => [
                  release.platform,
                  release.channel,
                  release.releaseId,
                ]),
                input.timeRange.start,
                input.timeRange.end,
              ]),
            );
      const hourlyByRelease = new Map<string, unknown[]>();
      for (const row of hourly) {
        const releaseId = Reflect.get(row as object, "release_id");
        const platform = Reflect.get(row as object, "platform");
        const channel = Reflect.get(row as object, "channel");
        if (
          typeof releaseId !== "string" ||
          (platform !== "ios" && platform !== "android") ||
          typeof channel !== "string"
        ) {
          throw new Error("Invalid D1 Insights hourly release key.");
        }
        const key = insightsReleaseKey({ releaseId, platform, channel });
        const rows = hourlyByRelease.get(key) ?? [];
        rows.push(row);
        hourlyByRelease.set(key, rows);
      }
      const measuredAtMs = Date.now();
      return {
        coverage: { kind: "complete" as const, sinceMs: 0 },
        data: input.releases.map((release) => {
          const key = insightsReleaseKey(release);
          const row = summaryByKey.get(key);
          return {
            release,
            summary: {
              activeInstallations:
                row === undefined ? 0 : d1Number(row, "active_installations"),
              pendingInstallations:
                row === undefined ? 0 : d1Number(row, "pending_installations"),
              downloadedInstallations:
                row === undefined
                  ? 0
                  : d1Number(row, "downloaded_installations"),
              recoveredInstallations:
                row === undefined
                  ? 0
                  : d1Number(row, "recovered_installations"),
            },
            ...(input.timeRange === undefined
              ? {}
              : {
                  series: (hourlyByRelease.get(key) ?? []).map((point) => ({
                    startMs: d1Number(point, "hour_start_ms"),
                    downloadedReports: d1Number(point, "downloaded_reports"),
                    appliedReports: d1Number(point, "applied_reports"),
                    recoveredReports: d1Number(point, "recovered_reports"),
                  })),
                }),
            measuredAtMs,
          };
        }),
      };
    },
  };
  return {
    recordInsights: (input) =>
      recordProjectedInsightsEvent(releaseActivityProjection, input),
    getReleaseActivity: (input) =>
      releaseActivityProjection.getReleaseActivity(input),
    async findLatestInsightsEvents(input) {
      const where = buildD1Where(latestInsightsWhere(input));
      const rows = await executor.query(
        `SELECT event.* FROM (SELECT id, install_id FROM bundle_event_heads${where.sql} ORDER BY install_id ASC LIMIT json_extract(?, '$')) AS head JOIN bundle_events AS event ON event.id = head.id ORDER BY head.install_id ASC`,
        [
          ...where.params,
          ...encodeD1Values(["installId" in input ? 1 : input.limit]),
        ],
      );
      return rows.map((row) => parseD1Row("bundle_events", row));
    },
    async countLatestInsightsEvents(input) {
      const groups = latestInsightsCountGroups(input).map(buildD1Where);
      const where = {
        sql: ` WHERE (${groups.map((group) => `(${group.sql.replace(/^ WHERE /, "")})`).join(" OR ")})`,
        params: groups.flatMap((group) => group.params),
      };
      const rows = await executor.query(
        `SELECT COUNT(*) AS count FROM bundle_event_heads${where.sql}`,
        where.params,
      );
      const first = rows[0];
      const count =
        typeof first === "object" && first !== null
          ? Reflect.get(first, "count")
          : undefined;
      if (typeof count !== "number")
        throw new Error("Invalid Insights count result.");
      return count;
    },
    async create(input) {
      const query = insertQuery(input);
      const rows = await executor.query(query.sql, query.params);
      switch (input.model) {
        case "bundles":
          return parseD1Row("bundles", rows[0]);
        case "bundle_patches":
          return parseD1Row("bundle_patches", rows[0]);
        case "channels":
          return parseD1Row("channels", rows[0]);
        case "bundle_events":
          return parseD1Row("bundle_events", rows[0]);

        case "api_keys":
          return parseD1Row("api_keys", rows[0]);
        case "releases":
          return parseD1Row("releases", rows[0]);
        case "release_catalogs":
          return parseD1Row("release_catalogs", rows[0]);
      }
    },
    async update(input) {
      const query = updateQuery(input);
      const rows = await executor.query(query.sql, query.params);
      if (rows[0] === undefined) return null;
      switch (input.model) {
        case "bundles":
          return parseD1Row("bundles", rows[0]);
        case "api_keys":
          return parseD1Row("api_keys", rows[0]);
        case "releases":
          return parseD1Row("releases", rows[0]);
        case "release_catalogs":
          return parseD1Row("release_catalogs", rows[0]);
      }
    },
    async delete(input) {
      const query = deleteQuery(input);
      await executor.query(query.sql, query.params);
    },
    count: (input) => countD1Rows(executor, input),
    async findOne(input: FindOneDatabaseImplementationInput) {
      const where = buildD1Where(input.where);
      const rows = await executor.query(
        `SELECT * FROM ${d1TableNames[input.model]}${where.sql} LIMIT 1`,
        where.params,
      );
      if (rows[0] === undefined) return null;
      switch (input.model) {
        case "bundles":
          return parseD1Row("bundles", rows[0]);
        case "bundle_patches":
          return parseD1Row("bundle_patches", rows[0]);
        case "channels":
          return parseD1Row("channels", rows[0]);
        case "api_keys":
          return parseD1Row("api_keys", rows[0]);
        case "releases":
          return parseD1Row("releases", rows[0]);
        case "release_catalogs":
          return parseD1Row("release_catalogs", rows[0]);
      }
    },
    findMany: (input) => findManyD1Rows(executor, input),
    insertChannel: (input) => insertChannel(executor, input),
    deleteChannel: (input) => deleteChannel(executor, input),
    async commit(input) {
      if (input.changes.length === 0) return { committed: true };
      const expectations = input.expectations ?? [];
      const conflict = await expectationConflict(executor, expectations);
      if (conflict !== null) return conflict;
      const plan = createCommitPlan(input);
      try {
        return resultForPlan(plan, await executor.batch(plan.statements));
      } catch (error) {
        if (expectations.length === 0 || !isExpectationConflictError(error)) {
          throw error;
        }
        return (
          (await expectationConflict(executor, expectations)) ?? {
            committed: false,
            conflict: {
              actualVersion:
                expectations[0].model === "releases"
                  ? expectations[0].revision
                  : expectations[0].generation,
              changeIndex: -1,
              expectedVersion:
                expectations[0].model === "releases"
                  ? expectations[0].revision
                  : expectations[0].generation,
              key:
                expectations[0].model === "releases"
                  ? expectations[0].id
                  : expectations[0].scopeKey,
              model: expectations[0].model,
              reason: "version_conflict",
            },
          }
        );
      }
    },
  };
};
