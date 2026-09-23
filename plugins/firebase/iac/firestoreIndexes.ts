import { FIREBASE_V1_COLLECTION } from "../src/firebaseInfrastructureNames";

/**
 * `firestore.indexes.json` for the storage engine's one collection. Its
 * queries read one partition's sort keys, so they need (pk, sk) in each
 * direction. No query filters on a row value, so `row` and its fields are
 * exempt from single-field indexing, which also keeps catalog payloads and
 * sketches clear of Firestore's indexed-value limit.
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
  ],
});
