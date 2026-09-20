import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FIREBASE_V1_COLLECTION_NAMES } from "../src/firebaseInfrastructureNames";

type Order = "ASCENDING" | "DESCENDING";

const index = (
  collectionGroup: string,
  fields: readonly (readonly [string, Order])[],
) => ({
  collectionGroup,
  queryScope: "COLLECTION",
  fields: fields.map(([fieldPath, order]) => ({ fieldPath, order })),
});

describe("firebase firestore index template", () => {
  it("contains only the composite indexes used by runtime queries", async () => {
    const indexFilePath = path.resolve(
      __dirname,
      "../firebase/public/firestore.indexes.json",
    );
    const indexFile = JSON.parse(await readFile(indexFilePath, "utf8"));
    const events = FIREBASE_V1_COLLECTION_NAMES.bundleEvents;
    const installations = FIREBASE_V1_COLLECTION_NAMES.insightsLatest;
    const overview = FIREBASE_V1_COLLECTION_NAMES.insightsOverview;
    const asc = "ASCENDING" as const;
    const desc = "DESCENDING" as const;

    expect(indexFile).toEqual({
      indexes: [
        index(events, [
          ["received_at_ms", desc],
          ["id", desc],
        ]),
        index(events, [
          ["install_id", asc],
          ["type", asc],
          ["received_at_ms", desc],
          ["id", desc],
        ]),
        index(installations, [
          ["user_id", asc],
          ["install_id", asc],
        ]),
        index(events, [
          ["type", asc],
          ["platform", asc],
          ["channel", asc],
          ["from_bundle_id", asc],
          ["received_at_ms", desc],
          ["id", desc],
        ]),
        index(events, [
          ["type", asc],
          ["platform", asc],
          ["channel", asc],
          ["to_bundle_id", asc],
          ["received_at_ms", desc],
          ["id", desc],
        ]),
        index(installations, [
          ["platform", asc],
          ["channel", asc],
          ["received_at_ms", asc],
        ]),
        ...["from_bundle_id", "to_bundle_id"].map((field) =>
          index(installations, [
            ["platform", asc],
            ["channel", asc],
            [field, asc],
            ["type", asc],
            ["received_at_ms", asc],
          ]),
        ),
        index(overview, [
          ["scope_kind", asc],
          ["channel", asc],
          ["period_kind", asc],
          ["bucket_start_ms", asc],
        ]),
        index(overview, [
          ["scope_kind", asc],
          ["channel", asc],
          ["period_kind", asc],
          ["platform", asc],
          ["bucket_start_ms", asc],
        ]),
        index(overview, [
          ["scope_kind", asc],
          ["channel", asc],
          ["period_kind", asc],
          ["app_version", asc],
          ["bucket_start_ms", asc],
        ]),
        index(overview, [
          ["scope_kind", asc],
          ["channel", asc],
          ["period_kind", asc],
          ["platform", asc],
          ["app_version", asc],
          ["bucket_start_ms", asc],
        ]),
      ],
      fieldOverrides: [
        ...[events, installations].map((collectionGroup) => ({
          collectionGroup,
          fieldPath: "metadata",
          indexes: [],
        })),
        ...["launch_users", "activity_users"].map((fieldPath) => ({
          collectionGroup: overview,
          fieldPath,
          indexes: [],
        })),
      ],
    });
  });
});
