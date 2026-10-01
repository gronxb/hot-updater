import { createKvAdapter } from "@hot-updater/plugin-core";
import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";

import { createFirestoreTestDatabase } from "../test-utils/createFirestoreTestDatabase";
import { createFirestoreStore } from "./firestoreStore";

const { firestore, clearCollection } = createFirestoreTestDatabase(
  "firebase-read-budgets-test",
);

/**
 * `firebaseDatabase()`'s storage without its schema fence: the key-value
 * helper over the Firestore store in the emulator, its pages as small as the
 * suite's, in a collection of its own.
 */
setupReadBudgetTestSuite({
  name: "key-value (Firestore emulator)",
  createAdapter: async ({ nativePageSize }) => {
    const collection = `read_budgets_${process.pid}`;
    await clearCollection(collection);
    return {
      adapter: createKvAdapter({
        store: createFirestoreStore({ firestore, collection, nativePageSize }),
      }),
      indexCopies: true,
      cleanup: () => clearCollection(collection),
    };
  },
});
