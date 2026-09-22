import { DatabasePluginInputError } from "@hot-updater/plugin-core";
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
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import type {
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";

import {
  d1InsightsStatements,
  getD1AppUsage,
  getD1ReleaseActivity,
} from "./d1InsightsOverview";
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

// An invalid JSON path aborts the native batch, including earlier writes. The
// path carries only core-generated indexes/versions so conflicts can be reported
// from the same atomic execution, without a racy post-rollback snapshot.
const COMMIT_CONFLICT_MARKER = "HOT_UPDATER_COMMIT";

const assertQuery = (condition: D1Guard, failure: string): D1Statement => ({
  sql: `SELECT CASE WHEN ${condition.sql} THEN 1 ELSE json_extract('null', '$${COMMIT_CONFLICT_MARKER}_${failure}_END') END`,
  params: condition.params,
});

const expectationQuery = (
  expectation: DatabaseCommitExpectation,
  index: number,
): D1Statement => {
  const isRelease = expectation.model === "releases";
  const table = isRelease ? "releases" : "release_catalogs";
  const keyField = isRelease ? "id" : "scope_key";
  const versionField = isRelease ? "revision" : "generation";
  const key = isRelease ? expectation.id : expectation.scopeKey;
  const version = isRelease ? expectation.revision : expectation.generation;
  return {
    sql: `SELECT CASE WHEN actual_version IS json_extract(?, '$') THEN 1 ELSE json_extract('null', '$${COMMIT_CONFLICT_MARKER}_expectation_${index}_' || COALESCE(CAST(actual_version AS INTEGER), 'null') || '_END') END FROM (SELECT (SELECT ${versionField} FROM ${table} WHERE ${keyField} = json_extract(?, '$')) AS actual_version)`,
    params: encodeD1Values([version, key]),
  };
};

const commitConflict = (
  error: unknown,
  input: DatabaseCommit,
): DatabaseCommitResult | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  const change = message.match(
    /HOT_UPDATER_COMMIT_(not_found|referenced|invalid_data)_(\d+)_END/,
  );
  if (change) {
    if (change[1] === "invalid_data")
      throw new DatabasePluginInputError("invalid-data");
    return {
      committed: false,
      conflict: {
        changeIndex: Number(change[2]),
        reason: change[1] as "not_found" | "referenced",
      },
    };
  }
  const mismatch = message.match(
    /HOT_UPDATER_COMMIT_expectation_(\d+)_(null|\d+)_END/,
  );
  if (!mismatch) return undefined;
  const expectation = input.expectations?.[Number(mismatch[1])];
  if (!expectation) return undefined;
  return {
    committed: false,
    conflict: {
      actualVersion: mismatch[2] === "null" ? null : Number(mismatch[2]),
      changeIndex: -1,
      expectedVersion:
        expectation.model === "releases"
          ? expectation.revision
          : expectation.generation,
      key:
        expectation.model === "releases"
          ? expectation.id
          : expectation.scopeKey,
      model: expectation.model,
      reason: "version_conflict",
    },
  };
};

const bundleValues = (row: BundleRow): readonly unknown[] => [
  row.id,
  row.platform,
  row.git_commit_hash,
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
  conflictMode: "returnExisting" | "ignore" = "returnExisting",
): D1Statement => {
  let columns: readonly string[];
  let values: readonly unknown[];
  switch (input.model) {
    case "bundles":
      columns = [
        "id",
        "platform",
        "git_commit_hash",
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
    sql: `INSERT INTO ${d1TableNames[input.model]} (${columns.join(", ")}) VALUES (${d1Placeholders(values.length)})${conflict} RETURNING *`,
    params: encodeD1Values(values),
  };
};

const updateEntries = (
  update: UpdateDatabaseImplementationInput["update"],
): readonly [string, unknown][] => Object.entries(update);

const updateQuery = (input: UpdateDatabaseImplementationInput): D1Statement => {
  const entries = updateEntries(input.update);
  const where = buildD1Where(input.where);
  if (entries.length === 0) {
    return {
      sql: `SELECT * FROM ${d1TableNames[input.model]}${where.sql} LIMIT 1`,
      params: where.params,
    };
  }
  const assignments = entries
    .map(([field]) => `${field} = json_extract(?, '$')`)
    .join(", ");
  return {
    sql: `UPDATE ${d1TableNames[input.model]} SET ${assignments}${where.sql} RETURNING *`,
    params: [
      ...encodeD1Values(entries.map(([, value]) => value)),
      ...where.params,
    ],
  };
};

const deleteQuery = (input: DeleteDatabaseImplementationInput): D1Statement => {
  const where = buildD1Where(input.where);
  return {
    sql: `DELETE FROM ${d1TableNames[input.model]}${where.sql}`,
    params: where.params,
  };
};

const changeQuery = (change: DatabaseChange): D1Statement => {
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          return insertQuery({ model: "bundles", data: change.row });
        case "update":
          return updateQuery({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
            update: change.update,
          });
        case "delete":
          return deleteQuery({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
          });
      }
    case "bundlePatches":
      return change.operation === "insert"
        ? insertQuery({ model: "bundle_patches", data: change.row })
        : deleteQuery({
            model: "bundle_patches",
            where: [{ field: "bundle_id", value: change.where.bundleId }],
          });
    case "releases":
      switch (change.operation) {
        case "insert":
          return insertQuery({ model: "releases", data: change.row });
        case "update":
          return updateQuery({
            model: "releases",
            where: [{ field: "id", value: change.where.id }],
            update: change.update,
          });
        case "delete":
          return deleteQuery({
            model: "releases",
            where: [{ field: "id", value: change.where.id }],
          });
      }
    case "releaseCatalogs":
      return {
        sql: `INSERT INTO release_catalogs (${Object.keys(change.row).join(", ")}) VALUES (${d1Placeholders(Object.keys(change.row).length)}) ON CONFLICT(scope_key) DO UPDATE SET ${Object.keys(
          change.row,
        )
          .filter((field) => field !== "scope_key")
          .map((field) => `${field} = excluded.${field}`)
          .join(", ")} RETURNING *`,
        params: encodeD1Values(Object.values(change.row)),
      };
    case "channels":
      return change.operation === "insert"
        ? insertQuery(
            {
              model: "channels",
              data: change.row,
              onConflict: change.onConflict,
            },
            "ignore",
          )
        : {
            sql: `DELETE FROM channels WHERE id = json_extract(?, '$')`,
            params: encodeD1Values([change.where.id]),
          };
    case "apiKeys":
      return change.operation === "insert"
        ? insertQuery(
            {
              model: "api_keys",
              data: change.row,
              onConflict: change.onConflict,
            },
            "ignore",
          )
        : updateQuery({
            model: "api_keys",
            where: [{ field: "id", value: change.where.id }],
            update: { revoked_at_ms: change.update.revokedAtMs },
          });
  }
};

const createCommitStatements = (input: DatabaseCommit): D1Statement[] => {
  const statements = (input.expectations ?? []).map(expectationQuery);
  for (const [changeIndex, change] of input.changes.entries()) {
    if (change.operation === "update") {
      const table = change.model === "apiKeys" ? "api_keys" : change.model;
      statements.push(
        assertQuery(
          {
            sql: `EXISTS (SELECT 1 FROM ${table} WHERE id = json_extract(?, '$'))`,
            params: encodeD1Values([change.where.id]),
          },
          `not_found_${changeIndex}`,
        ),
      );
      if (Object.keys(change.update).length === 0) continue;
    }
    if (
      (change.model === "bundles" || change.model === "channels") &&
      change.operation === "delete"
    ) {
      const field = change.model === "bundles" ? "bundle_id" : "channel_id";
      statements.push(
        assertQuery(
          {
            sql: `NOT EXISTS (SELECT 1 FROM releases WHERE ${field} = json_extract(?, '$'))`,
            params: encodeD1Values([change.where.id]),
          },
          `referenced_${changeIndex}`,
        ),
      );
    }
    if (change.model === "releases" && change.operation === "insert") {
      statements.push(
        assertQuery(
          {
            sql: `EXISTS (SELECT 1 FROM channels WHERE id = json_extract(?, '$')) AND (json_extract(?, '$') IS NULL OR EXISTS (SELECT 1 FROM bundles WHERE id = json_extract(?, '$') AND platform = json_extract(?, '$')))`,
            params: encodeD1Values([
              change.row.channel_id,
              change.row.bundle_id,
              change.row.bundle_id,
              change.row.platform,
            ]),
          },
          `invalid_data_${changeIndex}`,
        ),
      );
    }
    const statement = changeQuery(change);
    // Commit callers need a success/conflict result, never the mutated rows.
    statements.push({
      ...statement,
      sql: statement.sql.replace(/ RETURNING \*$/, ""),
    });
  }
  return statements;
};

const insertChannel = async (
  executor: D1Executor,
  input: ChannelInsertInput,
): Promise<ChannelInsertResult> => {
  const insert = insertQuery(
    { model: "channels", data: input.row, onConflict: "ignore" },
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

export const createD1Implementation = (
  executor: D1Executor,
): DatabasePluginImplementation => ({
  async recordInsights({ event }) {
    const query = insertQuery({ model: "bundle_events", data: event });
    await executor.batch([
      {
        sql: query.sql.replace(" RETURNING *", " ON CONFLICT(id) DO NOTHING"),
        params: query.params,
      },
      ...d1InsightsStatements(event),
      {
        sql: `INSERT INTO bundle_event_heads (install_id, id, received_at_ms, user_id, platform, channel, type, from_bundle_id, to_bundle_id, current_release_id, app_version)
SELECT install_id, id, received_at_ms, user_id, platform, channel, type, from_bundle_id, to_bundle_id,
  CASE WHEN type = 'UPDATE_DOWNLOADED' THEN from_release_id ELSE to_release_id END,
  app_version
FROM bundle_events WHERE id = json_extract(?, '$')
  AND insights_processed = 0
ON CONFLICT(install_id) DO UPDATE SET
  id = excluded.id, received_at_ms = excluded.received_at_ms, user_id = excluded.user_id,
  platform = excluded.platform, channel = excluded.channel, type = excluded.type,
  from_bundle_id = excluded.from_bundle_id, to_bundle_id = excluded.to_bundle_id,
  current_release_id = excluded.current_release_id, app_version = excluded.app_version
WHERE (excluded.received_at_ms, excluded.id) > (bundle_event_heads.received_at_ms, bundle_event_heads.id)`,
        params: encodeD1Values([event.id]),
      },
      {
        sql: "UPDATE bundle_events SET insights_processed = 1 WHERE id = json_extract(?, '$') AND insights_processed = 0",
        params: encodeD1Values([event.id]),
      },
    ]);
  },
  getReleaseActivity: (input) => getD1ReleaseActivity(executor, input),
  getAppUsage: (input) => getD1AppUsage(executor, input),
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
    const statements = createCommitStatements(input);
    if (statements.length === 0) return { committed: true };
    try {
      await executor.batch(statements);
      return { committed: true };
    } catch (error) {
      const conflict = commitConflict(error, input);
      if (conflict) return conflict;
      throw error;
    }
  },
});
