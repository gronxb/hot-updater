import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIREBASE_V1_COLLECTION_NAMES,
  FIREBASE_V2_INSIGHTS_COLLECTION_NAMES,
} from "../src/firebaseInfrastructureNames";

describe("firebase firestore index template", () => {
  it("ships sharded native Insights pages and source processing", async () => {
    const indexFile = JSON.parse(
      await readFile(
        path.resolve(__dirname, "../firebase/public/firestore.indexes.json"),
        "utf8",
      ),
    );
    const indexes = indexFile.indexes.filter(
      (index: { collectionGroup: string }) =>
        index.collectionGroup === FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events,
    );
    for (const equality of [
      ["_insights_page_shard"],
      ["_insights_install_key", "type", "_insights_page_shard"],
      ["type", "_insights_to_bundle_key", "_insights_page_shard"],
      ["type", "_insights_from_bundle_key", "_insights_page_shard"],
    ]) {
      expect(indexes).toContainEqual({
        collectionGroup: FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events,
        queryScope: "COLLECTION",
        fields: [
          ...equality.map((fieldPath) => ({ fieldPath, order: "ASCENDING" })),
          { fieldPath: "received_at_ms", order: "DESCENDING" },
          { fieldPath: "id", order: "DESCENDING" },
        ],
      });
    }
    expect(indexes).toContainEqual({
      collectionGroup: FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events,
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "_insights_source_shard", order: "ASCENDING" },
        { fieldPath: "_insights_source_seq", order: "ASCENDING" },
      ],
    });
    expect(indexFile.indexes).toContainEqual({
      collectionGroup:
        FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.installationVersions,
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "recordKind", order: "ASCENDING" },
        { fieldPath: "installKey", order: "ASCENDING" },
        { fieldPath: "sourceId", order: "ASCENDING" },
        { fieldPath: "sourceSequence", order: "DESCENDING" },
      ],
    });
    for (const [collectionGroup, fieldPath] of [
      [FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events, "received_at_ms"],
      [FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events, "_insights_page_shard"],
      [FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events, "_insights_source_seq"],
      [FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.installations, "received_at_ms"],
      [
        FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.installationVersions,
        "sourceSequence",
      ],
      [FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.sourceClocks, "sequence"],
    ] as const) {
      expect(indexFile.fieldOverrides).toContainEqual({
        collectionGroup,
        fieldPath,
        indexes: [],
      });
    }
    for (const [collectionGroup, fields] of [
      [
        FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.work,
        ["jobId", "recordKind", "orderKey"],
      ],
      [
        FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.reportRows,
        ["publicationId", "sectionKey", "ordinal"],
      ],
      [
        FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.reportRows,
        ["publicationId", "sectionKey", "bundleKey", "bundleOrdinal"],
      ],
    ] as const) {
      expect(indexFile.indexes).toContainEqual({
        collectionGroup,
        queryScope: "COLLECTION",
        fields: fields.map((fieldPath) => ({
          fieldPath,
          order: "ASCENDING",
        })),
      });
    }
    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.work,
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "jobId", order: "ASCENDING" },
        { fieldPath: "recordKind", order: "ASCENDING" },
        { fieldPath: "total", order: "DESCENDING" },
        { fieldPath: "label0", order: "ASCENDING" },
        { fieldPath: "label1", order: "ASCENDING" },
        { fieldPath: "label2", order: "ASCENDING" },
        { fieldPath: "orderKey", order: "ASCENDING" },
      ],
    });
    expect(indexFile.indexes).toContainEqual({
      collectionGroup: FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.work,
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "jobId", order: "ASCENDING" },
        { fieldPath: "recordKind", order: "ASCENDING" },
        { fieldPath: "sortSection", order: "ASCENDING" },
        { fieldPath: "sort0", order: "ASCENDING" },
        { fieldPath: "sort1", order: "ASCENDING" },
        { fieldPath: "sort2", order: "ASCENDING" },
        { fieldPath: "sort3", order: "ASCENDING" },
        { fieldPath: "sort4", order: "ASCENDING" },
        { fieldPath: "aggregateKey", order: "ASCENDING" },
      ],
    });
    for (const fieldPath of [
      "bucketCounts",
      "total",
      "label0",
      "label1",
      "label2",
      "sortSection",
      "sort0",
      "sort1",
      "sort2",
      "sort3",
      "sort4",
    ]) {
      expect(indexFile.fieldOverrides).toContainEqual({
        collectionGroup: FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.work,
        fieldPath,
        indexes: [],
      });
    }
    expect(indexFile.fieldOverrides).toContainEqual({
      collectionGroup: FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.reportRows,
      fieldPath: "bundleOrdinal",
      indexes: [],
    });
  });

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
