import { binding, secret } from "@hot-updater/core/config";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { describe, expect, it } from "vitest";

import { createFirebaseStorage } from "./storage/firebaseStorage";
import { createFirebaseStorageFake } from "./storage/firebaseStorageTestFake";
import { createFunctionsStorageContext } from "./storage/functionsContext";

const nodeContext = createNodeStorageContext({ environment: {} });

describe("Firebase Storage v2 context isolation", () => {
  it("resolves tagged Node options A to B to A without client reuse", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      {
        storageBucket: secret("BUCKET"),
        projectId: secret("PROJECT_ID"),
      },
      "node",
      fake.factory,
    );
    const contexts = ["a", "b", "a"].map((id) =>
      createNodeStorageContext({
        environment: {
          BUCKET: `bucket-${id}`,
          PROJECT_ID: `project-${id}`,
        },
      }),
    );

    for (const [index, context] of contexts.entries()) {
      await plugin.put({
        context,
        key: `object-${index}`,
        body: new Uint8Array([index]),
        contentLength: 1,
      });
    }

    expect(
      fake.created.map((config) => [
        config.storageBucket,
        config.appOptions.projectId,
      ]),
    ).toEqual([
      ["bucket-a", "project-a"],
      ["bucket-b", "project-b"],
      ["bucket-a", "project-a"],
    ]);
    expect(fake.scopes).toEqual(["operation", "operation", "operation"]);
    expect(fake.closed).toEqual([0, 1, 2]);
  });

  it("resolves Functions credential bindings per operation", async () => {
    const credentialA = { getAccessToken: async () => ({ expires_in: 1 }) };
    const credentialB = { getAccessToken: async () => ({ expires_in: 2 }) };
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      {
        credential: binding("FIREBASE_CREDENTIAL"),
        storageBucket: secret("BUCKET"),
      },
      "functions",
      fake.factory,
    );

    for (const credential of [credentialA, credentialB, credentialA]) {
      const context = createFunctionsStorageContext({
        environment: {
          BUCKET: credential === credentialA ? "bucket-a" : "bucket-b",
        },
        bindings: { FIREBASE_CREDENTIAL: credential },
      });
      await plugin.head({
        context,
        storageUri: `gs://${context.environment.BUCKET}/missing`,
      });
    }

    expect(fake.created.map((config) => config.appOptions.credential)).toEqual([
      credentialA,
      credentialB,
      credentialA,
    ]);
    expect(fake.closed).toEqual([0, 1, 2]);
  });

  it("rejects the wrong concrete target before client creation", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: "release-bucket" },
      "functions",
      fake.factory,
    );

    await expect(
      plugin.head({
        context: nodeContext,
        storageUri: "gs://release-bucket/object",
      }),
    ).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "invalid-input",
    });
    expect(fake.created).toHaveLength(0);
  });
});
