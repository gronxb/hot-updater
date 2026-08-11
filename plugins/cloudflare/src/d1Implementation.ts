import type {
  BundlePatchRow,
  BundleRow,
  CreateDatabaseImplementationInput,
  DatabaseChange,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateBundleDatabaseImplementationInput,
} from "@hot-updater/plugin-core";

import { countD1Rows, d1TableNames, findManyD1Rows } from "./d1Query";
import { parseD1Row } from "./d1Rows";
import { buildD1Where, d1Placeholders, encodeD1Values } from "./d1Sql";

export interface D1Executor {
  query(sql: string, params: readonly string[]): Promise<readonly unknown[]>;
  batch?: (
    statements: readonly D1Statement[],
  ) => Promise<readonly (readonly unknown[])[]>;
}

export interface D1Statement {
  readonly sql: string;
  readonly params: readonly string[];
}

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
  }
};

const guardedPatchInsertQuery = (
  row: BundlePatchRow,
  bundleId: string,
): D1Statement => {
  const columns = [
    "id",
    "bundle_id",
    "base_bundle_id",
    "base_file_hash",
    "patch_file_hash",
    "patch_storage_uri",
    "order_index",
  ];
  const values = patchValues(row);
  return {
    sql: `INSERT INTO bundle_patches (${columns.join(", ")}) SELECT ${d1Placeholders(values.length)} WHERE EXISTS (SELECT 1 FROM bundles WHERE id = json_extract(?, '$')) RETURNING *`,
    params: encodeD1Values([...values, bundleId]),
  };
};

const updateEntries = (
  update: UpdateBundleDatabaseImplementationInput["update"],
): readonly [string, unknown][] => Object.entries(update);

const updateQuery = (
  input: UpdateBundleDatabaseImplementationInput,
): D1Statement => {
  const entries = updateEntries(input.update);
  const where = buildD1Where(input.where);
  if (entries.length === 0) {
    return {
      sql: `SELECT * FROM bundles${where.sql} LIMIT 1`,
      params: where.params,
    };
  }
  const assignments = entries
    .map(([field]) => `${field} = json_extract(?, '$')`)
    .join(", ");
  return {
    sql: `UPDATE bundles SET ${assignments}${where.sql} RETURNING *`,
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

const changeQuery = (
  change: DatabaseChange,
  input: DatabaseCommit,
): D1Statement => {
  if (change.table === "bundles") {
    switch (change.operation) {
      case "insert":
        return insertQuery({ model: "bundles", data: change.row });
      case "update":
        return updateQuery({
          model: "bundles",
          where: [{ field: "id", value: change.id }],
          update: change.update,
        });
      case "delete":
        return deleteQuery({
          model: "bundles",
          where: [{ field: "id", value: change.id }],
        });
    }
  }
  if (change.operation === "insert") {
    return input.operation === "update"
      ? guardedPatchInsertQuery(change.row, input.bundleId)
      : insertQuery({ model: "bundle_patches", data: change.row });
  }
  return deleteQuery({
    model: "bundle_patches",
    where: [{ field: "bundle_id", value: change.bundleId }],
  });
};

type D1CommitPlan = {
  readonly appliedResultIndex?: number;
  readonly statements: readonly D1Statement[];
};

const createCommitPlan = (input: DatabaseCommit): D1CommitPlan => {
  if (input.operation !== "update") {
    return {
      statements: input.changes.map((change) => changeQuery(change, input)),
    };
  }
  const targetQuery: D1Statement = {
    sql: "SELECT id FROM bundles WHERE id = json_extract(?, '$') LIMIT 1",
    params: encodeD1Values([input.bundleId]),
  };
  return {
    appliedResultIndex: 0,
    statements: [
      targetQuery,
      ...input.changes.map((change) => changeQuery(change, input)),
    ],
  };
};

const resultForPlan = (
  plan: D1CommitPlan,
  results: readonly (readonly unknown[])[],
): DatabaseCommitResult => ({
  applied:
    plan.appliedResultIndex === undefined ||
    (results[plan.appliedResultIndex]?.length ?? 0) > 0,
});

export const createD1Implementation = (
  executor: D1Executor,
): DatabasePluginImplementation => {
  const implementation: DatabasePluginImplementation = {
    async create(input) {
      const query = insertQuery(input);
      const rows = await executor.query(query.sql, query.params);
      switch (input.model) {
        case "bundles":
          return parseD1Row("bundles", rows[0]);
        case "bundle_patches":
          return parseD1Row("bundle_patches", rows[0]);
      }
    },
    async update(input) {
      const query = updateQuery(input);
      const rows = await executor.query(query.sql, query.params);
      return rows[0] === undefined ? null : parseD1Row("bundles", rows[0]);
    },
    async delete(input: DeleteDatabaseImplementationInput) {
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
      }
    },
    findMany: (input) => findManyD1Rows(executor, input),
    async getChannels() {
      const rows = await executor.query(
        "SELECT DISTINCT channel FROM bundles ORDER BY channel ASC",
        [],
      );
      return rows.map(parseChannel);
    },
  };

  if (executor.batch) {
    implementation.commit = async (input) => {
      const plan = createCommitPlan(input);
      if (plan.statements.length === 0) return { applied: true };
      return resultForPlan(plan, await executor.batch!(plan.statements));
    };
    implementation.commitBatch = async (inputs) => {
      const plans = inputs.map(createCommitPlan);
      const offsets: number[] = [];
      const statements: D1Statement[] = [];
      for (const plan of plans) {
        offsets.push(statements.length);
        statements.push(...plan.statements);
      }
      if (statements.length === 0) {
        return plans.map(() => ({ applied: true }));
      }
      const results = await executor.batch!(statements);
      return plans.map((plan, index) =>
        resultForPlan(
          plan,
          results.slice(
            offsets[index],
            offsets[index] + plan.statements.length,
          ),
        ),
      );
    };
  }

  return implementation;
};
