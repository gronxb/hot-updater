import { builtInSchema, createKvAdapter } from "@hot-updater/server/database";
import {
  createMeasuredDatabase,
  targetBaseCandidateKey,
} from "@hot-updater/server/db";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
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
  server: {
    createMeasuredDatabase,
    builtInSchema,
    plugins: [insights(), apiKeys()],
    targetBaseCandidateKey,
  },
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
