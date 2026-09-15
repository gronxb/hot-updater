import type {
  BundlePatchPublishInput,
  BundlePatchPublishResult,
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
  DatabasePluginInputError,
  isContentAddressedAssetFileHash,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_PATCHES,
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
const PATCH_LIMIT_MARKER = "HOT_UPDATER_COMMIT_PATCH_LIMIT";

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

type D1BundleDeletePrecondition = {
  readonly id: string;
  readonly excludedOwnerIds: readonly string[];
  readonly addedReferencePatchIds: readonly string[];
};

const bundleDeletePrecondition = (
  changes: readonly DatabaseChange[],
  changeIndex: number,
  bundleId: string,
): D1BundleDeletePrecondition => {
  const excludedOwnerIds = new Set<string>();
  const addedPatches = new Map<string, BundlePatchRow>();
  for (const change of changes.slice(0, changeIndex)) {
    if (change.model === "bundlePatches") {
      if (change.operation === "insert") {
        addedPatches.set(change.row.id, change.row);
      } else {
        excludedOwnerIds.add(change.where.bundleId);
        for (const [id, patch] of addedPatches) {
          if (patch.bundle_id === change.where.bundleId)
            addedPatches.delete(id);
        }
      }
    } else if (change.model === "bundles" && change.operation === "delete") {
      excludedOwnerIds.add(change.where.id);
      for (const [id, patch] of addedPatches) {
        if (patch.bundle_id === change.where.id) addedPatches.delete(id);
      }
    }
  }
  return {
    id: bundleId,
    excludedOwnerIds: [...excludedOwnerIds],
    addedReferencePatchIds: [...addedPatches.values()]
      .filter(
        (patch) =>
          patch.base_bundle_id === bundleId && patch.bundle_id !== bundleId,
      )
      .map(({ id }) => id),
  };
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
  const bundleDeletes: D1BundleDeletePrecondition[] = [];
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
    if (change.model === "bundles" && change.operation === "delete") {
      const precondition = bundleDeletePrecondition(
        input.changes,
        changeIndex,
        change.where.id,
      );
      bundleDeletes.push(precondition);
      checks.push({
        changeIndex,
        resultIndex: statements.length,
        conflictWhen: "nonempty",
        reason: "referenced",
      });
      statements.push({
        sql: "SELECT id FROM bundle_patches WHERE base_bundle_id = json_extract(?, '$') AND bundle_id <> json_extract(?, '$') AND bundle_id NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT value AS id FROM json_each(?) LIMIT 1",
        params: encodeD1Values([
          precondition.id,
          precondition.id,
          precondition.excludedOwnerIds,
          precondition.addedReferencePatchIds,
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
    ) AND NOT EXISTS (
      SELECT 1 FROM json_each(?) AS bundle_delete
      WHERE EXISTS (
        SELECT 1 FROM bundle_patches
        WHERE bundle_patches.base_bundle_id = json_extract(bundle_delete.value, '$.id')
          AND bundle_patches.bundle_id <> json_extract(bundle_delete.value, '$.id')
          AND bundle_patches.bundle_id NOT IN (
            SELECT value FROM json_each(
              json_extract(bundle_delete.value, '$.excludedOwnerIds')
            )
          )
        UNION ALL
        SELECT value FROM json_each(
          json_extract(bundle_delete.value, '$.addedReferencePatchIds')
        )
      )
    )`,
    params: encodeD1Values([
      requiredRows.map(({ model, id }) => ({ model, id })),
      channelDeletes,
      bundleDeletes,
    ]),
  };

  statements.push(...input.changes.map((change) => changeQuery(change, guard)));
  const patchOwnerIds = [
    ...new Set(
      input.changes.flatMap((change) =>
        change.model === "bundlePatches" && change.operation === "insert"
          ? [change.row.bundle_id]
          : [],
      ),
    ),
  ];
  if (patchOwnerIds.length > 0) {
    statements.push({
      sql: `SELECT CASE WHEN NOT EXISTS (
        SELECT bundle_id FROM bundle_patches
        WHERE bundle_id IN (SELECT value FROM json_each(?))
        GROUP BY bundle_id
        HAVING COUNT(*) > json_extract(?, '$')
      ) THEN 1 ELSE json_extract('${PATCH_LIMIT_MARKER}', '$') END AS patch_limit_guard`,
      params: encodeD1Values([patchOwnerIds, MAX_BUNDLE_PATCHES]),
    });
  }
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

const publishD1BundlePatch = async (
  executor: D1Executor,
  input: BundlePatchPublishInput,
): Promise<BundlePatchPublishResult> => {
  const row = input.row;
  if (
    row.bundle_id === row.base_bundle_id ||
    row.id !== `${row.bundle_id}:${row.base_bundle_id}` ||
    row.byte_size > MAX_BUNDLE_ARTIFACT_BYTES ||
    !isContentAddressedAssetFileHash(row.base_file_hash) ||
    !isContentAddressedAssetFileHash(row.patch_file_hash)
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
  const referencesExist =
    "EXISTS (SELECT 1 FROM bundles WHERE id = json_extract(?, '$')) AND " +
    "EXISTS (SELECT 1 FROM bundles WHERE id = json_extract(?, '$'))";
  const referenceParams = encodeD1Values([row.bundle_id, row.base_bundle_id]);
  const publicationAllowed =
    `(EXISTS (SELECT 1 FROM bundle_patches WHERE id = json_extract(?, '$')) OR ` +
    `(SELECT COUNT(*) FROM bundle_patches WHERE bundle_id = json_extract(?, '$')) < json_extract(?, '$'))`;
  const publicationParams = encodeD1Values([
    row.id,
    row.bundle_id,
    MAX_BUNDLE_PATCHES,
  ]);
  const orderAggregate = input.position === "primary" ? "MIN" : "MAX";
  const orderOffset = input.position === "primary" ? "- 1" : "+ 1";
  const insertFields = [
    "id",
    "bundle_id",
    "base_bundle_id",
    "base_file_hash",
    "patch_file_hash",
    "patch_storage_uri",
    "byte_size",
  ] as const;
  const insertValues = insertFields.map((field) => row[field]);
  const [ownerRows = [], previousRows = [], , , , publishedRows = []] =
    await executor.batch([
      {
        sql: `UPDATE bundles SET file_hash = file_hash WHERE id = json_extract(?, '$') AND ${referencesExist} AND ${publicationAllowed} RETURNING id`,
        params: encodeD1Values([
          row.bundle_id,
          row.bundle_id,
          row.base_bundle_id,
          row.id,
          row.bundle_id,
          MAX_BUNDLE_PATCHES,
        ]),
      },
      {
        sql: "SELECT * FROM bundle_patches WHERE id = json_extract(?, '$') LIMIT 1",
        params: encodeD1Values([row.id]),
      },
      {
        sql: `DELETE FROM bundle_patches WHERE id = json_extract(?, '$') AND ${referencesExist} AND ${publicationAllowed}`,
        params: [
          ...encodeD1Values([row.id]),
          ...referenceParams,
          ...publicationParams,
        ],
      },
      {
        sql: `INSERT INTO bundle_patches (${insertFields.join(", ")}, order_index) SELECT ${d1Placeholders(insertValues.length)}, COALESCE((SELECT ${orderAggregate}(order_index) ${orderOffset} FROM bundle_patches WHERE bundle_id = json_extract(?, '$')), 0) WHERE ${referencesExist} AND ${publicationAllowed}`,
        params: encodeD1Values([
          ...insertValues,
          row.bundle_id,
          row.bundle_id,
          row.base_bundle_id,
          row.id,
          row.bundle_id,
          MAX_BUNDLE_PATCHES,
        ]),
      },
      {
        sql: `WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY order_index, id) - 1 AS next_order_index FROM bundle_patches WHERE bundle_id = json_extract(?, '$')) UPDATE bundle_patches SET order_index = (SELECT next_order_index FROM ranked WHERE ranked.id = bundle_patches.id) WHERE bundle_id = json_extract(?, '$') AND ${referencesExist}`,
        params: encodeD1Values([
          row.bundle_id,
          row.bundle_id,
          row.bundle_id,
          row.base_bundle_id,
        ]),
      },
      {
        sql: "SELECT * FROM bundle_patches WHERE bundle_id = json_extract(?, '$') ORDER BY order_index, id",
        params: encodeD1Values([row.bundle_id]),
      },
    ]);

  if (ownerRows.length === 0) {
    return {
      published: false,
      reason:
        publishedRows.length >= MAX_BUNDLE_PATCHES
          ? "limit_exceeded"
          : "not_found",
    };
  }
  return {
    patches: publishedRows.map((value) => parseD1Row("bundle_patches", value)),
    previous:
      previousRows[0] === undefined
        ? null
        : parseD1Row("bundle_patches", previousRows[0]),
    published: true,
  };
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
      {
        sql: `INSERT INTO bundle_event_heads (install_id, id, received_at_ms, user_id, platform, channel, type, from_bundle_id, to_bundle_id)
SELECT install_id, id, received_at_ms, user_id, platform, channel, type, from_bundle_id, to_bundle_id
FROM bundle_events WHERE id = json_extract(?, '$')
ON CONFLICT(install_id) DO UPDATE SET
  id = excluded.id, received_at_ms = excluded.received_at_ms, user_id = excluded.user_id,
  platform = excluded.platform, channel = excluded.channel, type = excluded.type,
  from_bundle_id = excluded.from_bundle_id, to_bundle_id = excluded.to_bundle_id
WHERE (excluded.received_at_ms, excluded.id) > (bundle_event_heads.received_at_ms, bundle_event_heads.id)`,
        params: encodeD1Values([event.id]),
      },
    ]);
  },
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
  publishBundlePatch: (input) => publishD1BundlePatch(executor, input),
  async commit(input) {
    if (input.changes.length === 0) return { committed: true };
    for (const change of input.changes) {
      if (
        change.model === "bundlePatches" &&
        change.operation === "insert" &&
        (change.row.bundle_id === change.row.base_bundle_id ||
          change.row.id !==
            `${change.row.bundle_id}:${change.row.base_bundle_id}` ||
          change.row.byte_size > MAX_BUNDLE_ARTIFACT_BYTES ||
          !isContentAddressedAssetFileHash(change.row.base_file_hash) ||
          !isContentAddressedAssetFileHash(change.row.patch_file_hash))
      ) {
        throw new DatabasePluginInputError("invalid-data");
      }
    }
    const expectations = input.expectations ?? [];
    const conflict = await expectationConflict(executor, expectations);
    if (conflict !== null) return conflict;
    const plan = createCommitPlan(input);
    try {
      return resultForPlan(plan, await executor.batch(plan.statements));
    } catch (error) {
      if (!isExpectationConflictError(error)) {
        throw error;
      }
      const conflict =
        expectations.length === 0
          ? null
          : await expectationConflict(executor, expectations);
      if (conflict !== null) return conflict;
      if (
        input.changes.some(
          (change) =>
            change.model === "bundlePatches" && change.operation === "insert",
        )
      ) {
        throw new DatabasePluginInputError("invalid-data");
      }
      if (expectations.length === 0) throw error;
      return (
        conflict ?? {
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
});
