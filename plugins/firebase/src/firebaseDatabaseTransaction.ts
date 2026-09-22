import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import type {
  DatabaseWhere,
  DatabaseImplementationResult,
  DatabaseModel,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import type { Transaction } from "firebase-admin/firestore";

import {
  type FirebaseDatabaseCollections,
  persistFirebaseDatabaseSnapshot,
} from "./firebaseDatabasePersistence";
import { createFirebaseReads } from "./firebaseDatabaseReads";
import {
  cloneFirebaseDatabaseSnapshot,
  FirebaseDatabaseConstraintError,
  type FirebaseDatabaseSnapshot,
} from "./firebaseDatabaseState";

// Stage writes until the callback finishes: Firestore requires all reads before writes.
// Keep only rows addressed by the operation, including its foreign keys and cascades.
export const createFirebaseTransaction = (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
) => {
  const before: FirebaseDatabaseSnapshot = {
    bundles: new Map(),
    bundlePatches: new Map(),
    bundleEvents: new Map(),
    channels: new Map(),
    apiKeys: new Map(),
    releases: new Map(),
    releaseCatalogs: new Map(),
  };
  const after = cloneFirebaseDatabaseSnapshot(before);
  const reads = createFirebaseReads(collections, async () => {}, transaction);
  const maps = {
    bundles: "bundles",
    bundle_patches: "bundlePatches",
    bundle_events: "bundleEvents",
    channels: "channels",
    api_keys: "apiKeys",
    releases: "releases",
    release_catalogs: "releaseCatalogs",
  } as const;
  const rows = (snapshot: FirebaseDatabaseSnapshot, model: DatabaseModel) =>
    snapshot[maps[model]] as Map<string, DatabaseImplementationResult>;
  const rowKey = (row: DatabaseImplementationResult): string => {
    const key = "id" in row ? row.id : Reflect.get(row, "scope_key");
    if (typeof key !== "string")
      throw new DatabasePluginInputError("invalid-result");
    return key;
  };
  const loaded = new Set<string>();
  const keyOf = (model: DatabaseModel, field: string, value: string) =>
    JSON.stringify([model, field, value]);
  const selector = (
    model: DatabaseModel,
    where: readonly object[] | undefined,
  ) => {
    const condition = where?.length === 1 ? where[0] : undefined;
    const field = condition && Reflect.get(condition, "field");
    const value = condition && Reflect.get(condition, "value");
    const allowed =
      model === "release_catalogs"
        ? ["scope_key"]
        : model === "channels"
          ? ["id", "name"]
          : model === "api_keys"
            ? ["id", "hash"]
            : ["id"];
    if (
      !condition ||
      !allowed.includes(field) ||
      typeof value !== "string" ||
      (Reflect.get(condition, "operator") ?? "eq") !== "eq" ||
      Reflect.get(condition, "mode") === "insensitive"
    )
      throw new DatabasePluginInputError("invalid-operation");
    return { field: field as string, value };
  };
  const lookup = (model: DatabaseModel, field: string, value: string) => {
    const current = rows(after, model);
    return field === "id" || field === "scope_key"
      ? (current.get(value) ?? null)
      : ([...current.values()].find(
          (row) => Reflect.get(row, field) === value,
        ) ?? null);
  };
  const remember = (
    model: DatabaseModel,
    row: DatabaseImplementationResult | null,
  ) => {
    if (row === null) return;
    const key = rowKey(row);
    loaded.add(
      keyOf(model, model === "release_catalogs" ? "scope_key" : "id", key),
    );
    const oldRows = rows(before, model),
      newRows = rows(after, model);
    if (!oldRows.has(key)) {
      oldRows.set(key, row);
      if (!newRows.has(key)) newRows.set(key, row);
    }
  };
  const findOne: TransactionDatabasePluginImplementation["findOne"] = async (
    input,
  ) => {
    const { field, value } = selector(input.model, input.where);
    const staged = lookup(input.model, field, value);
    const key = keyOf(input.model, field, value);
    if (staged !== null || loaded.has(key)) return staged;
    remember(input.model, await reads.findOne(input));
    loaded.add(key);
    return lookup(input.model, field, value);
  };
  const loadPatches = async (
    field: "bundle_id" | "base_bundle_id",
    id: string,
  ) => {
    let cursor: string | undefined;
    while (true) {
      const where: DatabaseWhere<"bundle_patches">[] = [
        field === "bundle_id"
          ? { field: "bundle_id", value: id }
          : { field: "base_bundle_id", value: id },
      ];
      if (cursor !== undefined)
        where.push({ field: "id", operator: "gt", value: cursor });
      const rows = await reads.findMany({
        model: "bundle_patches",
        where,
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      });
      for (const row of rows) remember("bundle_patches", row);
      if (rows.length < 100) break;
      const last = rows.at(-1);
      if (last === undefined || !("id" in last))
        throw new DatabasePluginInputError("invalid-result");
      cursor = last.id;
    }
  };
  const database: TransactionDatabasePluginImplementation = {
    findOne,
    async findMany() {
      throw new DatabasePluginInputError("invalid-operation");
    },
    async count(input) {
      // Commit reference checks have exactly one relationship predicate.
      const condition = input.where?.length === 1 ? input.where[0] : undefined;
      if (
        input.model !== "releases" ||
        input.distinct !== undefined ||
        !condition ||
        !["bundle_id", "channel_id"].includes(condition.field) ||
        (condition.operator ?? "eq") !== "eq"
      )
        throw new DatabasePluginInputError("invalid-operation");
      const count = (snapshot: FirebaseDatabaseSnapshot) =>
        [...snapshot.releases.values()].filter(
          (row) => Reflect.get(row, condition.field) === condition.value,
        ).length;
      return (await reads.count(input)) - count(before) + count(after);
    },
    async create(input) {
      if (input.model === "release_catalogs") {
        await findOne({
          model: input.model,
          where: [{ field: "scope_key", value: input.data.scope_key }],
        });
      } else if (input.model !== "bundle_events") {
        await findOne({
          model: input.model,
          where: [{ field: "id", value: input.data.id }],
        });
      }
      if (input.model === "channels")
        await findOne({
          model: "channels",
          where: [{ field: "name", value: input.data.name }],
        });
      if (input.model === "api_keys")
        await findOne({
          model: "api_keys",
          where: [{ field: "hash", value: input.data.hash }],
        });
      if (input.model === "bundle_patches") {
        await findOne({
          model: "bundles",
          where: [{ field: "id", value: input.data.bundle_id }],
        });
        await findOne({
          model: "bundles",
          where: [{ field: "id", value: input.data.base_bundle_id }],
        });
      }
      if (input.model === "releases") {
        await findOne({
          model: "channels",
          where: [{ field: "id", value: input.data.channel_id }],
        });
        if (input.data.bundle_id !== null)
          await findOne({
            model: "bundles",
            where: [{ field: "id", value: input.data.bundle_id }],
          });
      }
      const current = rows(after, input.model);
      if (input.model === "channels" || input.model === "api_keys") {
        const field = input.model === "channels" ? "name" : "hash";
        const value = Reflect.get(input.data, field);
        const existing = lookup(input.model, field, value);
        if (existing !== null && input.onConflict === "ignore") return existing;
        if (existing !== null)
          throw new FirebaseDatabaseConstraintError(
            `${input.model}.${field}.unique`,
          );
      }
      if (current.has(rowKey(input.data)))
        throw new FirebaseDatabaseConstraintError(`${input.model}.id.unique`);
      if (input.model === "bundle_patches") {
        for (const id of [input.data.bundle_id, input.data.base_bundle_id])
          if (!after.bundles.has(id))
            throw new FirebaseDatabaseConstraintError(
              "bundle_patches.bundle.foreign-key",
            );
      }
      if (
        input.model === "releases" &&
        (!after.channels.has(input.data.channel_id) ||
          (input.data.bundle_id !== null &&
            !after.bundles.has(input.data.bundle_id)))
      )
        throw new FirebaseDatabaseConstraintError("releases.foreign-key");
      current.set(rowKey(input.data), input.data);
      return input.data;
    },
    async update(input) {
      const current = await findOne(input);
      if (current === null) return null;
      const updated = { ...current, ...input.update };
      rows(after, input.model).set(rowKey(current), updated);
      return updated;
    },
    async delete(input) {
      if (input.model === "bundle_patches") {
        const owner = input.where?.length === 1 ? input.where[0] : undefined;
        if (
          owner?.field !== "bundle_id" ||
          typeof owner.value !== "string" ||
          (owner.operator ?? "eq") !== "eq"
        )
          throw new DatabasePluginInputError("invalid-operation");
        await loadPatches("bundle_id", owner.value);
      } else {
        const row = await findOne(input);
        if (
          input.model === "bundles" &&
          row !== null &&
          "id" in row &&
          typeof row.id === "string"
        ) {
          await loadPatches("bundle_id", row.id);
          await loadPatches("base_bundle_id", row.id);
        }
      }
      if (input.model === "bundle_patches") {
        const owner = input.where![0].value;
        for (const [id, row] of after.bundlePatches)
          if (row.bundle_id === owner) after.bundlePatches.delete(id);
      } else {
        const { value: id } = selector(input.model, input.where);
        rows(after, input.model).delete(id);
        if (input.model === "bundles")
          for (const [patchId, patch] of after.bundlePatches)
            if (patch.bundle_id === id || patch.base_bundle_id === id)
              after.bundlePatches.delete(patchId);
      }
    },
  };
  return {
    database,
    persist: () =>
      persistFirebaseDatabaseSnapshot({
        transaction,
        collections,
        before,
        after,
      }),
  };
};
