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
  createFirebaseDatabaseState,
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
  const previous = createFirebaseDatabaseState(before);
  const state = createFirebaseDatabaseState(after);
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
  const remember = (
    model: DatabaseModel,
    row: DatabaseImplementationResult | null,
  ) => {
    if (row === null) return;
    const key = "id" in row ? row.id : Reflect.get(row, "scope_key");
    if (typeof key !== "string")
      throw new DatabasePluginInputError("invalid-result");
    const oldRows = before[maps[model]] as Map<
      string,
      DatabaseImplementationResult
    >;
    const newRows = after[maps[model]] as Map<
      string,
      DatabaseImplementationResult
    >;
    if (!oldRows.has(key)) {
      oldRows.set(key, row);
      // An insert staged earlier takes precedence over the persisted snapshot.
      if (!newRows.has(key)) newRows.set(key, row);
    }
  };
  const findOne: TransactionDatabasePluginImplementation["findOne"] = async (
    input,
  ) => {
    const staged = await state.findOne(input);
    if (staged !== null) return staged;
    remember(input.model, await reads.findOne(input));
    return state.findOne(input);
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
      const persisted = await reads.count(input);
      return (
        persisted - (await previous.count(input)) + (await state.count(input))
      );
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
      return state.create(input);
    },
    async update(input) {
      await findOne(input);
      return state.update(input);
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
      await state.delete(input);
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
