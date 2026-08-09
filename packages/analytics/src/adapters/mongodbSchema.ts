import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
} from "../provider/migration";
import {
  InvalidBundleEventPersistenceRowError,
  parseBundleEventPersistenceRow,
} from "../provider/rowParser";
import {
  MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR,
  mongoAnalyticsIndexes,
} from "./mongodbArtifacts";
import type {
  MongoAnalyticsCollection,
  MongoAnalyticsConfig,
} from "./mongodbTypes";
import { mongoOperationOptions } from "./mongodbTypes";

const MONGO_DRIFT_FINGERPRINT = "mongodb-analytics-schema-drift";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function hasSameCanonicalValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function getProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function hasUnexpectedCollectionOptions(options: unknown): boolean {
  return (
    getProperty(options, "capped") === true ||
    getProperty(options, "size") !== undefined ||
    getProperty(options, "max") !== undefined ||
    getProperty(options, "timeseries") !== undefined ||
    getProperty(options, "clusteredIndex") !== undefined ||
    getProperty(options, "changeStreamPreAndPostImages") !== undefined ||
    getProperty(options, "storageEngine") !== undefined ||
    getProperty(options, "collation") !== undefined ||
    getProperty(options, "indexOptionDefaults") !== undefined ||
    getProperty(options, "encryptedFields") !== undefined ||
    getProperty(options, "expireAfterSeconds") !== undefined ||
    getProperty(options, "recordPreImages") !== undefined ||
    getProperty(options, "viewOn") !== undefined ||
    getProperty(options, "pipeline") !== undefined
  );
}

type MongoIndexInventory = "exact" | "recoverable" | "drift";

function hasUnexpectedIndexOptions(index: unknown): boolean {
  return (
    getProperty(index, "sparse") === true ||
    getProperty(index, "hidden") === true ||
    getProperty(index, "expireAfterSeconds") !== undefined ||
    getProperty(index, "partialFilterExpression") !== undefined ||
    getProperty(index, "collation") !== undefined ||
    getProperty(index, "wildcardProjection") !== undefined ||
    getProperty(index, "weights") !== undefined ||
    getProperty(index, "storageEngine") !== undefined
  );
}

async function inspectIndexes(
  collection: MongoAnalyticsCollection,
  config: MongoAnalyticsConfig,
): Promise<MongoIndexInventory> {
  const indexes = await collection
    .listIndexes(mongoOperationOptions(config.session))
    .toArray();
  const idIndex = indexes.find(
    (index) => getProperty(index, "name") === "_id_",
  );
  if (
    !hasSameCanonicalValue(getProperty(idIndex, "key"), { _id: 1 }) ||
    hasUnexpectedIndexOptions(idIndex)
  ) {
    return "drift";
  }
  const expectedNames = new Set([
    "_id_",
    ...mongoAnalyticsIndexes.map(({ name }) => name),
  ]);
  const actualNames = indexes.map((index) =>
    String(getProperty(index, "name")),
  );
  if (
    new Set(actualNames).size !== actualNames.length ||
    actualNames.some((name) => !expectedNames.has(name))
  ) {
    return "drift";
  }

  for (const expected of mongoAnalyticsIndexes) {
    const actual = indexes.find(
      (index) => getProperty(index, "name") === expected.name,
    );
    if (actual === undefined) continue;
    if (!hasSameCanonicalValue(getProperty(actual, "key"), expected.key)) {
      return "drift";
    }
    if (
      (getProperty(actual, "unique") === true) !==
      (expected.unique === true)
    ) {
      return "drift";
    }
    if (hasUnexpectedIndexOptions(actual)) return "drift";
  }
  return indexes.length === mongoAnalyticsIndexes.length + 1
    ? "exact"
    : "recoverable";
}

async function getRowsKind(
  collection: MongoAnalyticsCollection,
  config: MongoAnalyticsConfig,
): Promise<"drift" | "v1-compatible" | "v2-only"> {
  const documents = await collection
    .find(
      {},
      { projection: { _id: 0 }, ...mongoOperationOptions(config.session) },
    )
    .toArray();
  const ids = new Set<string>();
  let v2Only = false;
  for (const document of documents) {
    const projected = Object.fromEntries(
      typeof document === "object" && document !== null
        ? Object.entries(document).filter(([key]) => key !== "_id")
        : [],
    );
    try {
      const row = parseBundleEventPersistenceRow(projected);
      if (ids.has(row.id)) return "drift";
      ids.add(row.id);
      if (row.type === "UNCHANGED") v2Only = true;
    } catch (error) {
      if (error instanceof InvalidBundleEventPersistenceRowError) {
        return "drift";
      }
      throw error;
    }
  }
  return v2Only ? "v2-only" : "v1-compatible";
}

export async function inspectMongoAnalyticsFingerprint(
  config: MongoAnalyticsConfig,
  componentVersion: string | null,
  legacyVersion: string | null,
): Promise<string | null> {
  const collectionInfo = await config.database
    .listCollections(
      { name: "bundle_events" },
      mongoOperationOptions(config.session),
    )
    .toArray();
  if (collectionInfo.length === 0) return null;
  if (collectionInfo.length !== 1) return MONGO_DRIFT_FINGERPRINT;
  const info = collectionInfo[0];
  if (getProperty(info, "type") !== "collection") {
    return MONGO_DRIFT_FINGERPRINT;
  }

  const collection = config.database.collection("bundle_events");
  const indexInventory = await inspectIndexes(collection, config);
  if (indexInventory === "drift") return MONGO_DRIFT_FINGERPRINT;
  const rowsKind = await getRowsKind(collection, config);
  if (rowsKind === "drift") return MONGO_DRIFT_FINGERPRINT;

  const options = getProperty(info, "options");
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    return MONGO_DRIFT_FINGERPRINT;
  }
  if (hasUnexpectedCollectionOptions(options)) return MONGO_DRIFT_FINGERPRINT;
  const validator = getProperty(options, "validator");
  if (validator !== undefined) {
    if (
      !hasSameCanonicalValue(validator, MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR) ||
      getProperty(options, "validationLevel") !== "strict" ||
      getProperty(options, "validationAction") !== "error"
    ) {
      return MONGO_DRIFT_FINGERPRINT;
    }
    if (indexInventory === "recoverable") {
      if (
        componentVersion === null &&
        legacyVersion !== "0.37.0" &&
        legacyVersion !== "0.38.0"
      ) {
        return null;
      }
      return MONGO_DRIFT_FINGERPRINT;
    }
    return ANALYTICS_SCHEMA_FINGERPRINT_V2;
  }
  if (
    getProperty(options, "validationLevel") !== undefined ||
    getProperty(options, "validationAction") !== undefined
  ) {
    return MONGO_DRIFT_FINGERPRINT;
  }
  if (indexInventory !== "exact") return MONGO_DRIFT_FINGERPRINT;
  if (legacyVersion === "0.38.0") {
    return ANALYTICS_SCHEMA_FINGERPRINT_V2;
  }
  if (legacyVersion === "0.37.0" && rowsKind === "v1-compatible") {
    return ANALYTICS_SCHEMA_FINGERPRINT_V1;
  }
  return MONGO_DRIFT_FINGERPRINT;
}
