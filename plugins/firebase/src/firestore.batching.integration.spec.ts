import * as engine from "@hot-updater/plugin-core/internal";
import { setupAggregateBatchingTestSuite } from "@hot-updater/test-utils";

import { createFirestoreTestDatabase } from "../test-utils/createFirestoreTestDatabase";
import { FIRESTORE_LIMITS, createFirestoreStore } from "./firestoreStore";

const { firestore, clearCollection } = createFirestoreTestDatabase(
  "firebase-batching-test",
);

/** `firebaseDatabase()`'s batching in the Firestore emulator, a collection per case. */
setupAggregateBatchingTestSuite({
  name: "key-value (Firestore emulator)",
  engine,
  createAdapter: async () => {
    const collection = `batching_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    return {
      adapter: engine.createKvAdapter({
        store: createFirestoreStore({ firestore, collection }),
      }),
      cleanup: () => clearCollection(collection),
    };
  },
  // Past the 500 writes one transaction takes: the compaction splits it.
  oversizedRows: FIRESTORE_LIMITS.items + 100,
});
