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
  DatabaseCommitResult,
} from "@hot-updater/plugin-core";
import type {
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
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

type D1Guard = {
  readonly sql: string;
  readonly params: readonly string[];
};

const bundleValues = (row: BundleRow): readonly unknown[] => [
  row.id,
  row.platform,
  row.should_force_update,
  row.enabled,
  row.file_hash,
  row.git_commit_hash,
  row.message,
  row.channel,
  row.channel_id,
  row.storage_uri,
  row.target_app_version,
  row.fingerprint_hash,
  row.metadata,
  row.rollout_cohort_count,
  row.target_cohorts,
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
        "should_force_update",
        "enabled",
        "file_hash",
        "git_commit_hash",
        "message",
        "channel",
        "channel_id",
        "storage_uri",
        "target_app_version",
        "fingerprint_hash",
        "metadata",
        "rollout_cohort_count",
        "target_cohorts",
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
        "order_index",
      ];
      values = patchValues(input.data);
      break;
    case "channels":
      columns = ["id", "name"];
      values = channelValues(input.data);
      break;
    case "bundle_events":
    case "client_access_keys":
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
        : input.model === "client_access_keys"
          ? conflictMode === "ignore"
            ? " ON CONFLICT(hash) DO NOTHING"
            : " ON CONFLICT(hash) DO UPDATE SET hash = excluded.hash"
          : "";

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
  readonly model: "bundles" | "client_access_keys";
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
  if (change.model === "clientAccessKeys") {
    return `client_access_keys:${change.row.id}`;
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
  if (change.model === "clientAccessKeys") {
    return {
      model: "client_access_keys",
      id: change.where.id,
      changeIndex,
    };
  }
  return undefined;
};

type D1ChannelDeletePrecondition = {
  readonly id: string;
  readonly excludedBundleIds: readonly string[];
  readonly addedReferenceBundleIds: readonly string[];
};

const channelDeletePrecondition = (
  changes: readonly DatabaseChange[],
  changeIndex: number,
  channelId: string,
): D1ChannelDeletePrecondition => {
  const bundleEffects = new Map<string, string | null>();
  for (const change of changes.slice(0, changeIndex)) {
    if (change.model !== "bundles") continue;
    switch (change.operation) {
      case "insert":
        bundleEffects.set(change.row.id, change.row.channel_id);
        break;
      case "update":
        if (change.update.channel_id !== undefined) {
          bundleEffects.set(change.where.id, change.update.channel_id);
        }
        break;
      case "delete":
        bundleEffects.set(change.where.id, null);
        break;
    }
  }
  return {
    id: channelId,
    excludedBundleIds: [...bundleEffects.keys()],
    addedReferenceBundleIds: [...bundleEffects]
      .filter(([, finalChannelId]) => finalChannelId === channelId)
      .map(([bundleId]) => bundleId),
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
            sql: `DELETE FROM channels WHERE id = json_extract(?, '$') AND NOT EXISTS (SELECT 1 FROM bundles WHERE channel_id = json_extract(?, '$')) AND ${guard.sql}`,
            params: [
              ...encodeD1Values([change.where.id, change.where.id]),
              ...guard.params,
            ],
          };
    case "analytics":
      return insertQuery({ model: "bundle_events", data: change.row }, guard);
    case "clientAccessKeys":
      return change.operation === "insert"
        ? insertQuery(
            {
              model: "client_access_keys",
              data: change.row,
              onConflict: change.onConflict,
            },
            guard,
            "ignore",
          )
        : updateQuery(
            {
              model: "client_access_keys",
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
        sql: "SELECT id FROM bundles WHERE channel_id = json_extract(?, '$') AND id NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT value AS id FROM json_each(?) LIMIT 1",
        params: encodeD1Values([
          precondition.id,
          precondition.excludedBundleIds,
          precondition.addedReferenceBundleIds,
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
        SELECT 1 FROM client_access_keys
        WHERE json_extract(required.value, '$.model') = 'client_access_keys'
          AND client_access_keys.id = json_extract(required.value, '$.id')
        UNION ALL
        SELECT 1 FROM channels
        WHERE json_extract(required.value, '$.model') = 'channels'
          AND channels.id = json_extract(required.value, '$.id')
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM json_each(?) AS channel_delete
      WHERE EXISTS (
        SELECT 1 FROM bundles
        WHERE bundles.channel_id = json_extract(channel_delete.value, '$.id')
          AND bundles.id NOT IN (
            SELECT value FROM json_each(
              json_extract(channel_delete.value, '$.excludedBundleIds')
            )
          )
        UNION ALL
        SELECT value FROM json_each(
          json_extract(channel_delete.value, '$.addedReferenceBundleIds')
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
        sql: "SELECT id FROM bundles WHERE channel_id = json_extract(?, '$') LIMIT 1",
        params: encodeD1Values([input.id]),
      },
      {
        sql: "DELETE FROM channels WHERE id = json_extract(?, '$') AND NOT EXISTS (SELECT 1 FROM bundles WHERE channel_id = json_extract(?, '$')) RETURNING id",
        params: encodeD1Values([input.id, input.id]),
      },
    ]);
  if (channelRows.length === 0) return { deleted: false, reason: "not_found" };
  if (referenceRows.length > 0) return { deleted: false, reason: "not_empty" };
  return deletedRows.length > 0
    ? { deleted: true }
    : { deleted: false, reason: "not_empty" };
};

export const createD1Implementation = (
  executor: D1Executor,
): DatabasePluginImplementation => ({
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
      case "client_access_keys":
        return parseD1Row("client_access_keys", rows[0]);
    }
  },
  async update(input) {
    const query = updateQuery(input);
    const rows = await executor.query(query.sql, query.params);
    if (rows[0] === undefined) return null;
    return input.model === "bundles"
      ? parseD1Row("bundles", rows[0])
      : parseD1Row("client_access_keys", rows[0]);
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
      case "client_access_keys":
        return parseD1Row("client_access_keys", rows[0]);
    }
  },
  findMany: (input) => findManyD1Rows(executor, input),
  insertChannel: (input) => insertChannel(executor, input),
  deleteChannel: (input) => deleteChannel(executor, input),
  async commit(input) {
    if (input.changes.length === 0) return { committed: true };
    const plan = createCommitPlan(input);
    return resultForPlan(plan, await executor.batch(plan.statements));
  },
});
