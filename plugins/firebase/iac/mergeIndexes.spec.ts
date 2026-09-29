import { describe, expect, it } from "vitest";

import { mergeIndexes } from "./index";

describe("mergeIndexes", () => {
  it("replaces a field's override and keeps every other one", () => {
    const merged = mergeIndexes(
      {
        indexes: [],
        fieldOverrides: [
          {
            collectionGroup: "hot_updater_v1",
            fieldPath: "row",
            indexes: [{ queryScope: "COLLECTION", order: "ASCENDING" }],
          },
          {
            collectionGroup: "hot_updater_v1_bundle_events",
            fieldPath: "metadata",
            indexes: [],
          },
        ],
      },
      {
        indexes: [],
        fieldOverrides: [
          { collectionGroup: "hot_updater_v1", fieldPath: "row", indexes: [] },
        ],
      },
    );

    expect(merged.fieldOverrides).toEqual([
      {
        collectionGroup: "hot_updater_v1_bundle_events",
        fieldPath: "metadata",
        indexes: [],
      },
      { collectionGroup: "hot_updater_v1", fieldPath: "row", indexes: [] },
    ]);
  });

  it("keeps indexes that differ only in a field's direction", () => {
    const index = (order: "ASCENDING" | "DESCENDING") => ({
      collectionGroup: "hot_updater_v1",
      queryScope: "COLLECTION" as const,
      fields: [
        { fieldPath: "pk", order: "ASCENDING" as const },
        { fieldPath: "sk", order },
      ],
    });

    expect(
      mergeIndexes(
        { indexes: [index("ASCENDING")], fieldOverrides: [] },
        {
          indexes: [index("ASCENDING"), index("DESCENDING")],
          fieldOverrides: [],
        },
      ).indexes,
    ).toEqual([index("ASCENDING"), index("DESCENDING")]);
  });
});
