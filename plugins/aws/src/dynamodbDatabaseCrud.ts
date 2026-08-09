import type {
  DatabaseImplementationResult,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";

import {
  createDynamoDBBundle,
  createDynamoDBPatch,
  deleteDynamoDBBundles,
  deleteDynamoDBPatch,
  replaceDynamoDBBundle,
} from "./dynamodbDatabaseCrudMutations";
import {
  loadBundleItemsById,
  loadMetadataCount,
} from "./dynamodbDatabaseKeyReads";
import {
  queryCompleteOwnerPatches,
  queryCompleteOwnersPatches,
} from "./dynamodbDatabaseOwnerReads";
import {
  countDistinctDynamoDBRows,
  matchesDynamoDBWhere,
  queryDynamoDBRows,
} from "./dynamodbDatabaseQuery";
import {
  dynamoDBBundlePageStart,
  exactDynamoDBBundleIds,
  exactDynamoDBId,
  exactDynamoDBPatchOwner,
  exactDynamoDBPatchOwners,
} from "./dynamodbDatabaseReadPatterns";
import {
  loadBundleItems,
  loadBundleItem,
  loadPatchItems,
  loadPatchItem,
  queryBundleItemsPage,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";

class DynamoDBUnsupportedModelError extends Error {
  readonly name = "DynamoDBUnsupportedModelError";

  constructor() {
    super("DynamoDB received an unsupported database model");
  }
}

const distinctFields = (
  fields: readonly string[] | undefined,
): readonly string[] | undefined => fields;

export const createDynamoDBCrud = (
  store: DynamoDBStore,
  updateIndexName: string,
): DatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        await createDynamoDBBundle(store, input.data);
        return input.data;
      case "bundle_patches":
        await createDynamoDBPatch(store, input.data);
        return input.data;
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async update(input): Promise<DatabaseImplementationResult | null> {
    const id = exactDynamoDBId(input.where);
    const current =
      id === undefined
        ? (await loadBundleItems(store)).find(({ row }) =>
            matchesDynamoDBWhere(row, input.where),
          )
        : await loadBundleItem(store, id);
    if (!current) return null;
    const updated = { ...current.row, ...input.update };
    await replaceDynamoDBBundle(store, current, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "bundle_patches") {
      const items = (await loadPatchItems(store)).filter(({ row }) =>
        matchesDynamoDBWhere(row, input.where),
      );
      for (const item of items) await deleteDynamoDBPatch(store, item);
      return;
    }
    const bundleItems = (await loadBundleItems(store)).filter(({ row }) =>
      matchesDynamoDBWhere(row, input.where),
    );
    if (bundleItems.length === 0) return;
    await deleteDynamoDBBundles(
      store,
      bundleItems,
      await loadPatchItems(store),
    );
  },
  async count(input): Promise<number> {
    if (
      (input.where === undefined || input.where.length === 0) &&
      input.distinct === undefined
    ) {
      const count = await loadMetadataCount(store, input.model);
      if (count !== undefined) return count;
    }
    switch (input.model) {
      case "bundles": {
        const rows = (await loadBundleItems(store))
          .map(({ row }) => row)
          .filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
      case "bundle_patches": {
        const ownerId = exactDynamoDBPatchOwner(input.where);
        const rows = (
          ownerId
            ? await queryCompleteOwnerPatches(store, updateIndexName, ownerId)
            : (await loadPatchItems(store)).map(({ row }) => row)
        ).filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    const id = exactDynamoDBId(input.where);
    switch (input.model) {
      case "bundles":
        if (id !== undefined)
          return (await loadBundleItem(store, id))?.row ?? null;
        return (
          (await loadBundleItems(store))
            .map(({ row }) => row)
            .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
        );
      case "bundle_patches":
        if (id !== undefined)
          return (await loadPatchItem(store, id))?.row ?? null;
        {
          const ownerId = exactDynamoDBPatchOwner(input.where);
          if (ownerId === undefined) break;
          return (
            (
              await queryCompleteOwnerPatches(store, updateIndexName, ownerId)
            ).find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
          );
        }
        break;
    }
    if (input.model === "bundle_patches") {
      return (
        (await loadPatchItems(store))
          .map(({ row }) => row)
          .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
      );
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async findMany(input): Promise<readonly DatabaseImplementationResult[]> {
    if (input.limit === 0) return [];
    switch (input.model) {
      case "bundles": {
        const ids = exactDynamoDBBundleIds(input.where);
        if (ids !== undefined) {
          return queryDynamoDBRows(
            (await loadBundleItemsById(store, ids)).map(({ row }) => row),
            input,
          );
        }
        const orderBy = input.orderBy;
        const direction = orderBy?.[0]?.direction;
        if (
          (input.offset ?? 0) === 0 &&
          input.distinctOn === undefined &&
          orderBy?.length === 1 &&
          orderBy[0]?.field === "id" &&
          (direction === "asc" || direction === "desc")
        ) {
          return (
            await queryBundleItemsPage(store, {
              direction,
              limit: input.limit ?? 100,
              matches: (row) => matchesDynamoDBWhere(row, input.where),
              start: dynamoDBBundlePageStart(input.where, direction),
            })
          ).map(({ row }) => row);
        }
        return queryDynamoDBRows(
          (await loadBundleItems(store)).map(({ row }) => row),
          input,
        );
      }
      case "bundle_patches": {
        const ownerIds = exactDynamoDBPatchOwners(input.where);
        if (ownerIds !== undefined) {
          const ownerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
          return queryDynamoDBRows(
            ownerId !== undefined
              ? await queryCompleteOwnerPatches(store, updateIndexName, ownerId)
              : await queryCompleteOwnersPatches(
                  store,
                  updateIndexName,
                  ownerIds,
                ),
            input,
          );
        }
        return queryDynamoDBRows(
          (await loadPatchItems(store)).map(({ row }) => row),
          input,
        );
      }
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async getChannels(): Promise<string[]> {
    return [
      ...new Set((await loadBundleItems(store)).map(({ row }) => row.channel)),
    ].sort();
  },
});
