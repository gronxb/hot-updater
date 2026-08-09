import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("firebase firestore index template", () => {
  it("includes required ascending composite indexes", async () => {
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
      collectionGroup: "bundles",
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: "bundles",
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
      collectionGroup: "bundles",
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "fingerprint_hash", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    expect(indexFile.indexes).toContainEqual({
      collectionGroup: "bundle_events",
      fields: [
        { fieldPath: "received_at_ms", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });
  });
});
