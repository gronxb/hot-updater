import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FIREBASE_V1_COLLECTION_NAMES } from "../src/firebaseInfrastructureNames";

describe("firebase firestore index template", () => {
  it("includes indexes for update checks and bounded insights reads", async () => {
    const indexFilePath = path.resolve(
      __dirname,
      "../firebase/public/firestore.indexes.json",
    );
    const indexFile = JSON.parse(await readFile(indexFilePath, "utf8")) as {
      indexes: Array<{
        collectionGroup: string;
        fields: Array<{
          fieldPath: string;
          order: "ASCENDING" | "DESCENDING";
        }>;
        queryScope: string;
      }>;
    };

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleEvents,
      fields: [
        { fieldPath: "received_at_ms", order: "DESCENDING" },
        { fieldPath: "id", order: "DESCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleEvents,
      fields: [
        { fieldPath: "received_at_ms", order: "ASCENDING" },
        { fieldPath: "id", order: "DESCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleEvents,
      fields: [
        { fieldPath: "install_id", order: "ASCENDING" },
        { fieldPath: "type", order: "ASCENDING" },
        { fieldPath: "received_at_ms", order: "DESCENDING" },
        { fieldPath: "id", order: "DESCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleEvents,
      fields: [
        { fieldPath: "install_id", order: "ASCENDING" },
        { fieldPath: "type", order: "ASCENDING" },
        { fieldPath: "received_at_ms", order: "ASCENDING" },
        { fieldPath: "id", order: "DESCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleInstallations,
      fields: [
        { fieldPath: "user_id", order: "ASCENDING" },
        { fieldPath: "install_id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    for (const field of ["from_bundle_id", "to_bundle_id"]) {
      for (const order of ["ASCENDING", "DESCENDING"]) {
        expect(indexFile.indexes).toContainEqual({
          collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleEvents,
          fields: [
            { fieldPath: "type", order: "ASCENDING" },
            { fieldPath: "platform", order: "ASCENDING" },
            { fieldPath: "channel", order: "ASCENDING" },
            { fieldPath: field, order: "ASCENDING" },
            { fieldPath: "received_at_ms", order },
            { fieldPath: "id", order: "DESCENDING" },
          ],
          queryScope: "COLLECTION",
        });
      }
    }
    for (const extra of [[], ["to_bundle_id"]]) {
      expect(indexFile.indexes).toContainEqual({
        collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundleInstallations,
        fields: ["platform", "channel", ...extra, "received_at_ms"].map(
          (fieldPath) => ({ fieldPath, order: "ASCENDING" }),
        ),
        queryScope: "COLLECTION",
      });
    }

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundles,
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundles,
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "target_app_version", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V1_COLLECTION_NAMES.bundles,
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "fingerprint_hash", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });
  });
});
