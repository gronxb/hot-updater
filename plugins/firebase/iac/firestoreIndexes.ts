import { FIREBASE_V1_COLLECTION } from "../src/firebaseInfrastructureNames";
import { FIRESTORE_TTL_FIELD } from "../src/firestoreStore";

/**
 * `firestore.indexes.json` for the storage engine's one collection. Its
 * queries read one partition's sort keys, so they need (pk, sk) in each
 * direction. No query filters on a row value, so `row` and its fields are
 * exempt from single-field indexing, which also keeps catalog payloads and
 * sketches clear of Firestore's indexed-value limit. `expireAt` carries the
 * TTL policy that deletes expired items; no query reads it, so it is not
 * indexed either, which Firestore advises for a TTL field.
 */
export const firestoreIndexes = () => ({
  indexes: (["ASCENDING", "DESCENDING"] as const).map((order) => ({
    collectionGroup: FIREBASE_V1_COLLECTION,
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "pk", order: "ASCENDING" },
      { fieldPath: "sk", order },
    ],
  })),
  fieldOverrides: [
    { collectionGroup: FIREBASE_V1_COLLECTION, fieldPath: "row", indexes: [] },
    {
      collectionGroup: FIREBASE_V1_COLLECTION,
      fieldPath: FIRESTORE_TTL_FIELD,
      ttl: true,
      indexes: [],
    },
  ],
});
