import { registerManagedAccessKey } from "@hot-updater/better-auth/managed";
import admin from "firebase-admin";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createFirebaseManagedAccessKeyStore,
  FIREBASE_MANAGED_ACCESS_KEY_COLLECTION,
} from "./firebaseManagedAccessKeyStore";

const firstKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const secondKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";

describe("Firebase managed access-key store", () => {
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ projectId: "managed-access-key-test" });
  const firestore = admin.firestore(app);
  const collection = firestore.collection(
    FIREBASE_MANAGED_ACCESS_KEY_COLLECTION,
  );

  beforeEach(async () => {
    const documents = await collection.get();
    const batch = firestore.batch();
    for (const document of documents.docs) batch.delete(document.ref);
    await batch.commit();
  });

  it("persists multiple keys, exact hash lookups, ordering, and revocation", async () => {
    const store = createFirebaseManagedAccessKeyStore(firestore);
    const first = await registerManagedAccessKey({
      apiKey: firstKey,
      createdAt: 100,
      name: "First",
      store,
    });
    const second = await registerManagedAccessKey({
      apiKey: secondKey,
      createdAt: 200,
      name: "Second",
      store,
    });

    await expect(store.findByHash(first.hash)).resolves.toEqual(first);
    await expect(store.list()).resolves.toEqual([second, first]);

    await expect(
      store.revoke({ id: first.id, revokedAt: 300 }),
    ).resolves.toMatchObject({ enabled: false, revokedAt: 300 });
    await expect(store.findByHash(first.hash)).resolves.toMatchObject({
      enabled: false,
      revokedAt: 300,
    });
  });
});
