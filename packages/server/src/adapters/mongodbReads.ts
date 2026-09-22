import {
  type BundleEventRow,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import type {
  DatabaseImplementationResult,
  DatabasePluginImplementation,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";
import type { ClientSession, Document, Collection } from "mongodb";

import { hasNullOrderOverrides } from "./databasePluginUtils";
import {
  activeBundleFilter,
  type MongoCollections,
  mongoSessionOptions,
  WITHOUT_INTERNAL_FIELDS,
  WITHOUT_MONGO_ID,
} from "./mongodbCollections";
import {
  createMongoBundleWhere,
  createMongoWhereDocument,
  createMongoChannelWhere,
  createMongoApiKeyWhere,
  createMongoEventWhere,
  createMongoPatchWhere,
  createMongoReleaseCatalogWhere,
  createMongoReleaseWhere,
  createMongoSort,
} from "./mongodbQuery";

const findMongoRows = async (
  collections: MongoCollections,
  input: FindManyDatabaseImplementationInput,
  session?: ClientSession,
): Promise<readonly DatabaseImplementationResult[]> => {
  if (input.limit === 0) return [];
  const sources = {
    bundles: collections.bundles,
    bundle_patches: collections.bundlePatches,
    bundle_events: collections.bundleEvents,
    api_keys: collections.apiKeys,
    channels: collections.channels,
    releases: collections.releases,
    release_catalogs: collections.releaseCatalogs,
  };
  const collection = sources[
    input.model
  ] as unknown as Collection<DatabaseImplementationResult>;
  const predicate =
    input.model === "bundle_events"
      ? createMongoEventWhere(
          input.where as Parameters<typeof createMongoEventWhere>[0],
        )
      : createMongoWhereDocument(input.where);
  const where =
    input.model === "bundles" ? activeBundleFilter(predicate) : predicate;
  const projection =
    input.model === "bundles" ? WITHOUT_INTERNAL_FIELDS : WITHOUT_MONGO_ID;
  const options = {
    ...mongoSessionOptions(session),
    ...(input.model === "bundle_events"
      ? { collation: { locale: "simple" }, readPreference: "primary" as const }
      : {}),
  };
  if (hasNullOrderOverrides(input.orderBy)) {
    const nullFields: Document = {};
    const sort: Record<string, 1 | -1> = {};
    const exclude: Document = { ...projection };
    for (const [index, clause] of (input.orderBy ?? []).entries()) {
      if (clause.nulls !== undefined) {
        const key = `_hot_updater_null_${index}`;
        nullFields[key] = {
          $eq: [{ $ifNull: [`$${clause.field}`, null] }, null],
        };
        sort[key] = clause.nulls === "first" ? -1 : 1;
        exclude[key] = 0;
      }
      sort[clause.field] = clause.direction === "asc" ? 1 : -1;
    }
    return collection
      .aggregate<DatabaseImplementationResult>(
        [
          { $match: where },
          { $addFields: nullFields },
          { $sort: sort },
          { $skip: input.offset },
          { $limit: input.limit },
          { $project: exclude },
        ],
        options,
      )
      .toArray();
  }
  const cursor = collection
    .find(where as Document, { ...options, projection })
    .skip(input.offset)
    .limit(input.limit);
  const sort = createMongoSort(input);
  return (await (
    sort === undefined ? cursor : cursor.sort(sort)
  ).toArray()) as DatabaseImplementationResult[];
};

type MongoReadImplementation = Pick<
  DatabasePluginImplementation,
  | "count"
  | "findMany"
  | "findOne"
  | "findLatestInsightsEvents"
  | "countLatestInsightsEvents"
>;

export const createMongoReads = (
  collections: MongoCollections,
  session?: ClientSession,
): MongoReadImplementation => ({
  async findLatestInsightsEvents(input) {
    return collections.bundleEventHeads
      .aggregate<BundleEventRow>(
        [
          { $match: createMongoEventWhere(latestInsightsWhere(input)) },
          { $sort: { install_id: 1 } },
          { $limit: "installId" in input ? 1 : input.limit },
          {
            $lookup: {
              from: "bundle_events",
              localField: "id",
              foreignField: "id",
              as: "event",
            },
          },
          { $unwind: "$event" },
          { $replaceRoot: { newRoot: "$event" } },
          { $project: WITHOUT_MONGO_ID },
        ],
        {
          ...mongoSessionOptions(session),
          collation: { locale: "simple" },
          readPreference: "primary",
        },
      )
      .toArray();
  },
  async countLatestInsightsEvents(input) {
    const rows = await collections.bundleEventHeads
      .aggregate<{ count: number }>(
        [
          {
            $match: {
              $or: latestInsightsCountGroups(input).map(createMongoEventWhere),
            },
          },
          { $count: "count" },
        ],
        {
          ...mongoSessionOptions(session),
          collation: { locale: "simple" },
          readPreference: "primary",
        },
      )
      .toArray();
    return rows[0]?.count ?? 0;
  },
  count: async (input) => {
    if (input.distinct !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    switch (input.model) {
      case "bundles":
        return collections.bundles.countDocuments(
          activeBundleFilter(createMongoBundleWhere(input.where)),
          mongoSessionOptions(session),
        );
      case "bundle_patches":
        return collections.bundlePatches.countDocuments(
          createMongoPatchWhere(input.where),
          mongoSessionOptions(session),
        );
      case "releases":
        return collections.releases.countDocuments(
          createMongoReleaseWhere(input.where),
          mongoSessionOptions(session),
        );

      case "bundle_events":
        return collections.bundleEvents.countDocuments(
          createMongoEventWhere(input.where),
          {
            ...mongoSessionOptions(session),
            collation: { locale: "simple" },
            readPreference: "primary",
            ...(session === undefined
              ? { readConcern: { level: "snapshot" } }
              : {}),
          },
        );
    }
  },
  findOne: async (input) => {
    switch (input.model) {
      case "bundles":
        return collections.bundles.findOne(
          activeBundleFilter(createMongoBundleWhere(input.where)),
          {
            projection: WITHOUT_INTERNAL_FIELDS,
            ...mongoSessionOptions(session),
          },
        );
      case "channels":
        return collections.channels.findOne(
          createMongoChannelWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "api_keys":
        return collections.apiKeys.findOne(
          createMongoApiKeyWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "bundle_patches":
        return collections.bundlePatches.findOne(
          createMongoPatchWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "releases":
        return collections.releases.findOne(
          createMongoReleaseWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
      case "release_catalogs":
        return collections.releaseCatalogs.findOne(
          createMongoReleaseCatalogWhere(input.where),
          {
            projection: WITHOUT_MONGO_ID,
            ...mongoSessionOptions(session),
          },
        );
    }
  },
  findMany: (input) => {
    if (input.distinctOn !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    return findMongoRows(collections, input, session);
  },
});
