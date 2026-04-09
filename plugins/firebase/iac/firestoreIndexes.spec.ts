import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("firebase firestore index template", () => {
  it("includes ascending indexes for update-check fast paths", async () => {
    const indexFilePath = path.resolve(
      __dirname,
      "../firebase/public/firestore.indexes.json",
    );
    const indexFile = JSON.parse(
      await readFile(indexFilePath, "utf8"),
    ) as {
      indexes: Array<{
        fields: Array<{
          fieldPath: string;
          order: "ASCENDING" | "DESCENDING";
        }>;
      }>;
    };

    expect(indexFile.indexes).toContainEqual({
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "target_app_version", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
    });

    expect(indexFile.indexes).toContainEqual({
      fields: [
        { fieldPath: "channel", order: "ASCENDING" },
        { fieldPath: "enabled", order: "ASCENDING" },
        { fieldPath: "platform", order: "ASCENDING" },
        { fieldPath: "fingerprint_hash", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
    });
  });
});
