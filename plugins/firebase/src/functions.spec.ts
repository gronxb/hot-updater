import admin from "firebase-admin";
import { afterEach, describe, expect, it } from "vitest";

import { firebaseDatabase, firebaseStorage } from "./functions";

describe("Firebase Functions runtime plugins", () => {
  afterEach(async () => {
    await Promise.all(
      admin.apps.filter((app) => app !== null).map(async (app) => app.delete()),
    );
  });

  it("derives runtime configuration from the initialized Firebase app", () => {
    // Given: the Functions runtime initialized the default Admin app.
    admin.initializeApp({
      projectId: "hot-updater-test",
      storageBucket: "hot-updater-test.appspot.com",
    });

    // When: runtime plugins are created without deploy credentials.
    const database = firebaseDatabase();
    const storage = firebaseStorage()();

    // Then: both plugins use the Functions-specific implementations.
    expect(database.name).toBe("firebaseDatabase");
    expect(storage.name).toBe("firebaseFunctionsStorage");
    expect(storage.profiles.node).toBeUndefined();
  });
});
