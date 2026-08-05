import type { BundleEventPersistenceRow } from "../provider/persistence";
import type {
  MongoAnalyticsCollection,
  MongoAnalyticsDatabase,
  MongoAnalyticsDocument,
  MongoAnalyticsListCursor,
} from "./mongodb";
import {
  matchesMongoAnalyticsDocument,
  MongoAnalyticsHarnessCursor,
} from "./mongodbTestQuery";

export const legacyMongoIndexes = [
  { name: "_id_", key: { _id: 1 } },
  { name: "bundle_events_id_idx", key: { id: 1 }, unique: true },
  {
    name: "bundle_events_installed_bundle_idx",
    key: { type: 1, to_bundle_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_recovered_bundle_idx",
    key: { type: 1, from_bundle_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_install_idx",
    key: { install_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_user_id_idx",
    key: { user_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_username_idx",
    key: { username: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_cohort_idx",
    key: { cohort: 1, type: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_received_at_idx",
    key: { received_at_ms: 1, id: 1 },
  },
] satisfies readonly MongoAnalyticsDocument[];

export const transitionRow = (
  id: string,
  receivedAtMs: number,
): BundleEventPersistenceRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: "bundle-from",
  to_bundle_id: "bundle-to",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "fingerprint",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

type HarnessOptions = {
  readonly collectionOptions?: MongoAnalyticsDocument;
  readonly componentVersion?: unknown;
  readonly documents?: readonly MongoAnalyticsDocument[];
  readonly failMarkerOnce?: boolean;
  readonly indexes?: readonly MongoAnalyticsDocument[];
  readonly legacyVersion?: unknown;
  readonly validator?: unknown;
};

class HarnessDuplicateIdError extends Error {
  readonly name = "HarnessDuplicateIdError";
}

class HarnessListCursor implements MongoAnalyticsListCursor {
  constructor(private readonly documents: readonly MongoAnalyticsDocument[]) {}

  async toArray(): Promise<readonly MongoAnalyticsDocument[]> {
    return structuredClone(this.documents);
  }
}

export const createMongoAnalyticsHarness = (options: HarnessOptions = {}) => {
  const settings = new Map<string, unknown>();
  if (Object.hasOwn(options, "componentVersion")) {
    settings.set("schema.analytics", options.componentVersion);
  }
  if (Object.hasOwn(options, "legacyVersion")) {
    settings.set("version", options.legacyVersion);
  }
  const documents: MongoAnalyticsDocument[] = structuredClone([
    ...(options.documents ?? []),
  ]);
  const indexes: MongoAnalyticsDocument[] = structuredClone([
    ...(options.indexes ?? legacyMongoIndexes),
  ]);
  const operations: string[] = [];
  let bundleEventsExists = options.documents !== undefined;
  let validator = options.validator;
  let lastCursor: MongoAnalyticsHarnessCursor | null = null;
  let lastFilter: MongoAnalyticsDocument | null = null;
  let failMarkerOnce = options.failMarkerOnce === true;
  const collectionOptions = options.collectionOptions ?? {};
  let inventoryReadCount = 0;
  let markerReadCount = 0;

  const bundleEvents: MongoAnalyticsCollection = {
    createIndex: async (key, createOptions) => {
      const name = createOptions.name;
      indexes.push({
        key,
        name,
        ...(createOptions.unique === true ? { unique: true } : {}),
      });
      operations.push(`index:${name}`);
      return name;
    },
    find: (filter = {}) => {
      lastFilter = filter;
      lastCursor = new MongoAnalyticsHarnessCursor(
        documents.filter((document) =>
          matchesMongoAnalyticsDocument(document, filter),
        ),
      );
      return lastCursor;
    },
    findOne: async () => null,
    insertOne: async (document) => {
      const id = Reflect.get(document, "id");
      if (documents.some((row) => Reflect.get(row, "id") === id)) {
        throw new HarnessDuplicateIdError();
      }
      documents.push(structuredClone(document));
      operations.push(`insert:${String(id)}`);
      return undefined;
    },
    listIndexes: () => {
      inventoryReadCount += 1;
      return new HarnessListCursor(indexes);
    },
    updateOne: async () => undefined,
  };

  const settingsCollection: MongoAnalyticsCollection = {
    createIndex: async () => "unused",
    find: () => new MongoAnalyticsHarnessCursor([]),
    findOne: async (filter) => {
      const key = Reflect.get(filter, "key");
      if (key === "schema.analytics") markerReadCount += 1;
      if (typeof key !== "string" || !settings.has(key)) return null;
      return { key, value: settings.get(key) };
    },
    insertOne: async () => undefined,
    listIndexes: () => new HarnessListCursor([]),
    updateOne: async (filter, update) => {
      const key = Reflect.get(filter, "key");
      const set = Reflect.get(update, "$set");
      const value =
        typeof set === "object" && set !== null
          ? Reflect.get(set, "value")
          : undefined;
      if (failMarkerOnce) {
        failMarkerOnce = false;
        throw new HarnessDuplicateIdError();
      }
      if (typeof key === "string") settings.set(key, value);
      operations.push(`marker:${String(value)}`);
      return undefined;
    },
  };

  const database: MongoAnalyticsDatabase = {
    collection: (name) =>
      name === "private_hot_updater_settings"
        ? settingsCollection
        : bundleEvents,
    command: async (command) => {
      validator = Reflect.get(command, "validator");
      operations.push("validator:v2");
      return undefined;
    },
    createCollection: async (_name, createOptions) => {
      bundleEventsExists = true;
      validator = createOptions.validator;
      indexes.splice(0, indexes.length, { name: "_id_", key: { _id: 1 } });
      operations.push("collection:v2");
      return undefined;
    },
    listCollections: () =>
      new HarnessListCursor(
        bundleEventsExists
          ? [
              {
                name: "bundle_events",
                type: "collection",
                options:
                  validator === undefined
                    ? collectionOptions
                    : {
                        ...collectionOptions,
                        validationAction: "error",
                        validationLevel: "strict",
                        validator,
                      },
              },
            ]
          : [],
      ),
  };

  return {
    database,
    documents,
    getLastFilter: (): MongoAnalyticsDocument | null => lastFilter,
    getInventoryReadCount: (): number => inventoryReadCount,
    getLastLimit: (): number | null => lastCursor?.limitValue ?? null,
    getLastSort: (): MongoAnalyticsDocument | null =>
      lastCursor?.sortValue ?? null,
    getMarkerReadCount: (): number => markerReadCount,
    indexes,
    operations,
    resetReadCounts: (): void => {
      inventoryReadCount = 0;
      markerReadCount = 0;
    },
    settings,
  };
};
