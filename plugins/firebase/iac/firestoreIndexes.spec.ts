import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FIREBASE_V1_COLLECTION } from "../src/firebaseInfrastructureNames";
import { firestoreIndexes } from "./firestoreIndexes";

const INDEX_FILE = path.resolve(
  __dirname,
  "../firebase/public/firestore.indexes.json",
);

describe("firebase firestore index template", () => {
  it("checks in exactly the generated indexes", async () => {
    const generated = `${JSON.stringify(firestoreIndexes(), null, 2)}\n`;
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      await writeFile(INDEX_FILE, generated);
    }
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    expect(await readFile(INDEX_FILE, "utf8")).toBe(generated);
  });

  it("indexes only (pk, sk), in both directions, for the one collection", () => {
    const { indexes, fieldOverrides } = firestoreIndexes();

    expect(indexes).toEqual(
      (["ASCENDING", "DESCENDING"] as const).map((order) => ({
        collectionGroup: FIREBASE_V1_COLLECTION,
        queryScope: "COLLECTION",
        fields: [
          { fieldPath: "pk", order: "ASCENDING" },
          { fieldPath: "sk", order },
        ],
      })),
    );
    expect(fieldOverrides).toEqual([
      {
        collectionGroup: FIREBASE_V1_COLLECTION,
        fieldPath: "row",
        indexes: [],
      },
    ]);
  });
});
