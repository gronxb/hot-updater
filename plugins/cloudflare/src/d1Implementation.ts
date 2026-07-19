import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  CreateDatabaseImplementationInput,
  DatabaseAdapterImplementation,
  DatabaseModel,
  DeleteDatabaseImplementationInput,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateBundleDatabaseImplementationInput,
} from "@hot-updater/plugin-core";

import { parseD1Row } from "./d1Rows";
import {
  buildD1Order,
  buildD1Where,
  d1Placeholders,
  encodeD1Values,
} from "./d1Sql";

export interface D1Executor<TContext = unknown> {
  query(
    sql: string,
    params: readonly string[],
    context?: TContext,
  ): Promise<readonly unknown[]>;
}

const tableNames = {
  bundles: "bundles",
  bundle_patches: "bundle_patches",
  bundle_events: "bundle_events",
} as const satisfies Record<DatabaseModel, string>;

class InvalidD1ChannelAggregateError extends Error {
  readonly name = "InvalidD1ChannelAggregateError";
}

const parseChannel = (row: unknown): string => {
  if (typeof row !== "object" || row === null || !("channel" in row)) {
    throw new InvalidD1ChannelAggregateError();
  }
  const channel = row.channel;
  if (typeof channel !== "string") {
    throw new InvalidD1ChannelAggregateError();
  }
  return channel;
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

const bundleEventValues = (row: BundleEventRow): readonly unknown[] => [
  row.id,
  row.type,
  row.install_id,
  row.user_id,
  row.username,
  row.from_bundle_id,
  row.to_bundle_id,
  row.platform,
  row.app_version,
  row.channel,
  row.cohort,
  row.update_strategy,
  row.fingerprint_hash,
  row.sdk_version,
  row.received_at_ms,
];

const insertQuery = (input: CreateDatabaseImplementationInput) => {
  switch (input.model) {
    case "bundles": {
      const columns = [
        "id",
        "platform",
        "should_force_update",
        "enabled",
        "file_hash",
        "git_commit_hash",
        "message",
        "channel",
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
      const values = bundleValues(input.data);
      return {
        sql: `INSERT INTO bundles (${columns.join(", ")}) VALUES (${d1Placeholders(values.length)}) RETURNING *`,
        params: encodeD1Values(values),
      };
    }
    case "bundle_patches": {
      const columns = [
        "id",
        "bundle_id",
        "base_bundle_id",
        "base_file_hash",
        "patch_file_hash",
        "patch_storage_uri",
        "order_index",
      ];
      const values = patchValues(input.data);
      return {
        sql: `INSERT INTO bundle_patches (${columns.join(", ")}) VALUES (${d1Placeholders(values.length)}) RETURNING *`,
        params: encodeD1Values(values),
      };
    }
    case "bundle_events": {
      const columns = [
        "id",
        "type",
        "install_id",
        "user_id",
        "username",
        "from_bundle_id",
        "to_bundle_id",
        "platform",
        "app_version",
        "channel",
        "cohort",
        "update_strategy",
        "fingerprint_hash",
        "sdk_version",
        "received_at_ms",
      ];
      const values = bundleEventValues(input.data);
      return {
        sql: `INSERT INTO bundle_events (${columns.join(", ")}) VALUES (${d1Placeholders(values.length)}) RETURNING *`,
        params: encodeD1Values(values),
      };
    }
  }
};

const updateEntries = (
  update: UpdateBundleDatabaseImplementationInput["update"],
): readonly [string, unknown][] => Object.entries(update);

export const createD1Implementation = <TContext = unknown>(
  executor: D1Executor<TContext>,
): DatabaseAdapterImplementation<TContext> => ({
  async create(input, context) {
    const query = insertQuery(input);
    const rows = await executor.query(query.sql, query.params, context);
    switch (input.model) {
      case "bundles":
        return parseD1Row("bundles", rows[0]);
      case "bundle_patches":
        return parseD1Row("bundle_patches", rows[0]);
      case "bundle_events":
        return parseD1Row("bundle_events", rows[0]);
    }
  },
  async update(input, context) {
    const entries = updateEntries(input.update);
    if (entries.length === 0) {
      const where = buildD1Where(input.where);
      const rows = await executor.query(
        `SELECT * FROM bundles${where.sql} LIMIT 1`,
        where.params,
        context,
      );
      return rows[0] === undefined ? null : parseD1Row("bundles", rows[0]);
    }
    const assignments = entries
      .map(([field]) => `${field} = json_extract(?, '$')`)
      .join(", ");
    const where = buildD1Where(input.where);
    const rows = await executor.query(
      `UPDATE bundles SET ${assignments}${where.sql} RETURNING *`,
      [...encodeD1Values(entries.map(([, value]) => value)), ...where.params],
      context,
    );
    return rows[0] === undefined ? null : parseD1Row("bundles", rows[0]);
  },
  async delete(input: DeleteDatabaseImplementationInput, context) {
    const where = buildD1Where(input.where);
    await executor.query(
      `DELETE FROM ${tableNames[input.model]}${where.sql}`,
      where.params,
      context,
    );
  },
  async count(input, context) {
    const where = buildD1Where(input.where);
    const rows = await executor.query(
      `SELECT COUNT(*) AS count FROM ${tableNames[input.model]}${where.sql}`,
      where.params,
      context,
    );
    const row = rows[0];
    if (typeof row !== "object" || row === null || !("count" in row)) return 0;
    return Number(row.count);
  },
  async findOne(input: FindOneDatabaseImplementationInput, context) {
    const where = buildD1Where(input.where);
    const rows = await executor.query(
      `SELECT * FROM ${tableNames[input.model]}${where.sql} LIMIT 1`,
      where.params,
      context,
    );
    if (rows[0] === undefined) return null;
    switch (input.model) {
      case "bundles":
        return parseD1Row("bundles", rows[0]);
      case "bundle_patches":
        return parseD1Row("bundle_patches", rows[0]);
      case "bundle_events":
        return parseD1Row("bundle_events", rows[0]);
    }
  },
  async findMany(input: FindManyDatabaseImplementationInput, context) {
    const where = buildD1Where(input.where);
    const order = buildD1Order(
      input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined),
    );
    const pageParams = encodeD1Values([input.limit, input.offset]);
    const rows = await executor.query(
      `SELECT * FROM ${tableNames[input.model]}${where.sql}${order} LIMIT json_extract(?, '$') OFFSET json_extract(?, '$')`,
      [...where.params, ...pageParams],
      context,
    );
    switch (input.model) {
      case "bundles":
        return rows.map((row) => parseD1Row("bundles", row));
      case "bundle_patches":
        return rows.map((row) => parseD1Row("bundle_patches", row));
      case "bundle_events":
        return rows.map((row) => parseD1Row("bundle_events", row));
    }
  },
  async getChannels(context) {
    const rows = await executor.query(
      "SELECT DISTINCT channel FROM bundles ORDER BY channel ASC",
      [],
      context,
    );
    return rows.map(parseChannel);
  },
});
