import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
      collectionGroup: "bundles",
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });

    const eventIndexes = indexFile.indexes
      .filter(({ collectionGroup }) => collectionGroup === "bundle_events")
      .map(({ fields }) => fields.map(({ fieldPath }) => fieldPath));
    expect(eventIndexes).toEqual(
      expect.arrayContaining([
        ["received_at_ms", "id"],
        ["type", "received_at_ms", "id"],
        ["install_id", "type", "received_at_ms", "id"],
      ]),
    );

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
  });
});
