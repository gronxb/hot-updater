import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FIREBASE_V1_COLLECTION_NAMES } from "../src/firebaseInfrastructureNames";

describe("firebase firestore index template", () => {
  it("includes ascending indexes for update-check fast paths", async () => {
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
