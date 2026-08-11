import {
  defineUniversalComponentSchema,
  getUniversalComponentSchemaMarkerKey,
  type UniversalComponentDataAdapter,
  type UniversalComponentDataSource,
  UniversalComponentDataNotReadyError,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";
import {
  setupUniversalComponentDataAdapterTestSuite,
  setupUniversalComponentMigrationTestSuite,
  syntheticAuditLogMigrationSchema,
  syntheticMigrationLegacyEvidence,
  syntheticMigrationV2Row,
  type SyntheticUniversalComponentMigrationState,
  type UniversalComponentMigrationTestHarness,
} from "@hot-updater/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { mergeFirebaseComponentIndexArtifacts } from "./firebaseComponentIndexArtifacts";
import { firebaseDatabase } from "./firebaseDatabase";
import { createFirebaseUniversalComponentDataAdapter } from "./firebaseUniversalComponentData";

const PROJECT_ID = "firebase-component-data-test";

const {
  auditHistoryRecordsCollection,
  auditRecordsCollection,
  clearCollections,
  firestore,
  settingsCollection,
} = createFirestoreMock(PROJECT_ID);

const auditLogSchema = defineUniversalComponentSchema({
  id: "audit-log",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "audit_records",
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "recorded_at_ms", type: "integer" },
            { name: "category", type: "string" },
            { name: "details", type: "json" },
          ],
          indexes: [
            {
              columns: ["recorded_at_ms", "id"],
              name: "audit_records_chronological",
            },
            {
              columns: ["category", "id"],
              name: "audit_records_by_category",
            },
          ],
        },
      ],
      orderedScans: [
        {
          columns: ["recorded_at_ms", "id"],
          name: "chronological",
          table: "audit_records",
        },
      ],
    },
  ],
});

const uniqueIndexSchema = defineUniversalComponentSchema({
  id: "unique-audit-log",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "unique_audit_records",
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "external_id", type: "string" },
          ],
          indexes: [
            {
              columns: ["external_id"],
              name: "unique_audit_records_external_id",
              unique: true,
            },
          ],
        },
      ],
    },
    {
      version: "2",
      tables: [
        {
          name: "unique_audit_records",
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "external_id", type: "string" },
          ],
        },
      ],
    },
  ],
});

const auditRecord = (id: string, recordedAtMs: number) => ({
  category: "deployment",
  details: { actor: `actor-${id}` },
  id,
  recorded_at_ms: recordedAtMs,
});

const conformanceRecord = (id: string) => ({
  accepted: true,
  action: "configuration-read",
  actor_id: null,
  id,
  payload: { source: "firebase-readiness" },
  recorded_at_ms: 1,
  risk_score: 0.25,
});

const createAdapter = (): UniversalComponentDataAdapter => {
  const database = firebaseDatabase({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });
  if (database.componentData === undefined) {
    throw new Error("Missing universal component data adapter");
  }
  return database.componentData;
};

let conformanceIndexError: Error | null = null;

const createConformanceAdapter = (): UniversalComponentDataAdapter =>
  createFirebaseUniversalComponentDataAdapter(firestore, {
    validateIndexes: async () => {
      if (conformanceIndexError !== null) throw conformanceIndexError;
    },
  });

const migrateForReadinessFailure = async (
  adapter: UniversalComponentDataAdapter,
  schema: Parameters<UniversalComponentDataAdapter["bind"]>[0],
): Promise<void> => {
  if (adapter.migrate === undefined) {
    throw new TypeError("Missing Firebase component migration support");
  }
  await adapter.migrate(schema);
};

class FirebaseOperationalTestError extends Error {
  readonly name = "FirebaseOperationalTestError";
}

const runtimeOperations: readonly {
  readonly name: string;
  readonly run: (source: UniversalComponentDataSource) => Promise<unknown>;
}[] = [
  { name: "assertReady", run: (source) => source.assertReady() },
  {
    name: "append",
    run: (source) =>
      source.append({
        row: auditRecord("operational-error", 1),
        table: "audit_records",
      }),
  },
  {
    name: "orderedScan",
    run: (source) =>
      source.orderedScan({
        accessPattern: "chronological",
        beforePrefixExclusive: [2],
        limit: 1,
      }),
  },
];

describe("Firebase universal component data adapter", () => {
  beforeEach(clearCollections);

  it("derives Firestore indexes only from named ordered scans", () => {
    const adapter = createAdapter();

    expect(adapter.artifacts?.(auditLogSchema)).toEqual([
      {
        contents: `${JSON.stringify(
          {
            fieldOverrides: [],
            indexes: [
              {
                collectionGroup: "audit_records",
                fields: [
                  { fieldPath: "recorded_at_ms", order: "ASCENDING" },
                  { fieldPath: "id", order: "ASCENDING" },
                ],
                queryScope: "COLLECTION",
              },
            ],
          },
          null,
          2,
        )}\n`,
        path: "firestore.indexes.audit-log.1.json",
        targetVersion: "1",
      },
    ]);
    expect(adapter.artifacts?.(auditLogSchema)?.[0]?.contents).not.toContain(
      '"category"',
    );
  });

  it("rejects unique table indexes anywhere in schema history", () => {
    const adapter = createAdapter();

    expect(() => adapter.artifacts?.(uniqueIndexSchema)).toThrow(
      "Firebase cannot enforce unique component index on unique_audit_records",
    );
    expect(() => adapter.bind(uniqueIndexSchema)).toThrow(
      "Firebase cannot enforce unique component index on unique_audit_records",
    );
  });

  it("deterministically merges component fragments without dropping unrelated indexes", () => {
    const artifacts = createAdapter().artifacts?.(auditLogSchema) ?? [];
    const existing = JSON.stringify({
      fieldOverrides: [
        {
          collectionGroup: "external_records",
          fieldPath: "expires_at",
          indexes: [],
        },
      ],
      indexes: [
        {
          collectionGroup: "external_records",
          fields: [{ fieldPath: "created_at", order: "DESCENDING" }],
          queryScope: "COLLECTION",
        },
      ],
    });

    const once = mergeFirebaseComponentIndexArtifacts(existing, artifacts);
    const twice = mergeFirebaseComponentIndexArtifacts(once, artifacts);
    const aggregate = JSON.parse(once) as {
      fieldOverrides: unknown[];
      indexes: Array<{ collectionGroup: string }>;
    };

    expect(twice).toBe(once);
    expect(
      aggregate.indexes.map(({ collectionGroup }) => collectionGroup),
    ).toEqual(["audit_records", "external_records"]);
    expect(aggregate.fieldOverrides).toEqual([
      {
        collectionGroup: "external_records",
        fieldPath: "expires_at",
        indexes: [],
      },
    ]);
  });

  it("preserves Firestore composite field order while deduplicating", () => {
    const existing = JSON.stringify({
      fieldOverrides: [],
      indexes: [
        {
          collectionGroup: "ordered_records",
          fields: [
            { fieldPath: "first", order: "ASCENDING" },
            { fieldPath: "second", order: "ASCENDING" },
          ],
          queryScope: "COLLECTION",
        },
      ],
    });
    const artifact = {
      contents: JSON.stringify({
        fieldOverrides: [],
        indexes: [
          {
            collectionGroup: "ordered_records",
            fields: [
              { fieldPath: "second", order: "ASCENDING" },
              { fieldPath: "first", order: "ASCENDING" },
            ],
            queryScope: "COLLECTION",
          },
        ],
      }),
      path: "firestore.indexes.ordered-records.1.json",
      targetVersion: "1",
    } as const;

    const merged = JSON.parse(
      mergeFirebaseComponentIndexArtifacts(existing, [artifact]),
    ) as { indexes: unknown[] };

    expect(merged.indexes).toHaveLength(2);
  });

  it("replaces field overrides by Firestore field identity", () => {
    const existing = JSON.stringify({
      fieldOverrides: [
        {
          collectionGroup: "component_records",
          fieldPath: "expires_at",
          indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }],
        },
        {
          collectionGroup: "external_records",
          fieldPath: "expires_at",
          indexes: [],
          ttl: true,
        },
      ],
      indexes: [],
    });
    const artifact = {
      contents: JSON.stringify({
        fieldOverrides: [
          {
            collectionGroup: "component_records",
            fieldPath: "expires_at",
            indexes: [],
            ttl: true,
          },
        ],
        indexes: [],
      }),
      path: "firestore.indexes.component-records.1.json",
      targetVersion: "1",
    } as const;

    const merged = JSON.parse(
      mergeFirebaseComponentIndexArtifacts(existing, [artifact]),
    ) as {
      fieldOverrides: Array<{
        collectionGroup: string;
        indexes: unknown[];
        ttl?: boolean;
      }>;
    };

    expect(merged.fieldOverrides).toEqual([
      {
        collectionGroup: "component_records",
        fieldPath: "expires_at",
        indexes: [],
        ttl: true,
      },
      {
        collectionGroup: "external_records",
        fieldPath: "expires_at",
        indexes: [],
        ttl: true,
      },
    ]);
  });

  it("blocks writes before migration and advances only the component marker", async () => {
    const adapter = createAdapter();
    const source = adapter.bind(auditLogSchema);

    await expect(
      source.append({
        row: auditRecord("audit-before-migration", 1_000),
        table: "audit_records",
      }),
    ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);
    expect(
      (await auditRecordsCollection.doc("audit-before-migration").get()).exists,
    ).toBe(false);

    await expect(adapter.migrate?.(auditLogSchema)).resolves.toEqual({
      changed: true,
      version: "1",
    });
    expect(
      (await settingsCollection.doc("schema.audit-log").get()).data(),
    ).toEqual({ value: "1" });
    await expect(adapter.migrate?.(auditLogSchema)).resolves.toEqual({
      changed: false,
      version: "1",
    });
  });

  it("does not overwrite a malformed generic component marker", async () => {
    const adapter = createAdapter();
    const malformedMarker = { version: "1" };
    await settingsCollection.doc("schema.audit-log").set(malformedMarker);

    await expect(adapter.migrate?.(auditLogSchema)).rejects.toThrow(
      "Invalid universal component schema setting: schema.audit-log",
    );
    expect(
      (await settingsCollection.doc("schema.audit-log").get()).data(),
    ).toEqual(malformedMarker);
  });

  it("classifies a malformed marker document as physical schema drift at runtime", async () => {
    const adapter = createAdapter();
    await settingsCollection.doc("schema.audit-log").set({ version: "1" });

    await expect(adapter.bind(auditLogSchema).assertReady()).rejects.toEqual(
      expect.objectContaining({
        componentId: "audit-log",
        expectedVersion: "1",
        reason: "physical-schema",
      }),
    );
  });

  it.each(runtimeOperations)(
    "preserves operational Firestore marker reads through $name",
    async ({ run }) => {
      const adapter = createAdapter();
      await adapter.migrate?.(auditLogSchema);
      const source = adapter.bind(auditLogSchema);
      const operationalError = new FirebaseOperationalTestError();
      const markerReference = settingsCollection.doc("schema.audit-log");
      const documentReferencePrototype = Object.getPrototypeOf(
        markerReference,
      ) as Pick<typeof markerReference, "get">;
      const get = vi
        .spyOn(documentReferencePrototype, "get")
        .mockRejectedValueOnce(operationalError);

      try {
        await expect(run(source)).rejects.toBe(operationalError);
      } finally {
        get.mockRestore();
      }
    },
  );

  it("retries failed physical readiness and polls the marker after success", async () => {
    let indexesReady = true;
    const validateIndexes = vi.fn(async () => {
      if (!indexesReady) throw new Error("index drift");
    });
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
      validateIndexes,
    });
    await adapter.migrate?.(auditLogSchema);
    const source = adapter.bind(auditLogSchema);

    indexesReady = false;
    await expect(source.assertReady()).rejects.toEqual(
      expect.objectContaining({
        cause: expect.objectContaining({ message: "index drift" }),
        reason: "index",
      }),
    );
    indexesReady = true;
    await expect(source.assertReady()).resolves.toBeUndefined();

    await settingsCollection.doc("schema.audit-log").set({ value: "999" });
    await expect(source.assertReady()).rejects.toBeInstanceOf(
      UniversalComponentSchemaNotReadyError,
    );
    expect(validateIndexes).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: "document-key drift",
      reason: "physical-schema",
      seed: () =>
        auditRecordsCollection
          .doc("stored-document-key")
          .set(auditRecord("declared-primary-key", 1)),
    },
    {
      name: "stored row drift",
      reason: "stored-data",
      seed: () =>
        auditRecordsCollection.doc("stored-data-drift").set({
          ...auditRecord("stored-data-drift", 1),
          unexpected: true,
        }),
    },
  ] as const)(
    "classifies $name after the latest marker",
    async ({ reason, seed }) => {
      const adapter = createAdapter();
      await adapter.migrate?.(auditLogSchema);
      await seed();

      const error = await adapter
        .bind(auditLogSchema)
        .assertReady()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UniversalComponentDataNotReadyError);
      expect(error).toBeInstanceOf(UniversalComponentDataStateNotReadyError);
      expect(error).toMatchObject({
        componentId: "audit-log",
        expectedVersion: "1",
        reason,
      });
    },
  );

  it("appends by its declared primary key and preserves the generic row", async () => {
    const adapter = createAdapter();
    await adapter.migrate?.(auditLogSchema);
    const source = adapter.bind(auditLogSchema);
    const row = auditRecord("audit-primary-key", 1_000);

    await source.append({ row, table: "audit_records" });

    expect(
      (await auditRecordsCollection.doc("audit-primary-key").get()).data(),
    ).toEqual(row);
    await expect(
      source.append({ row, table: "audit_records" }),
    ).rejects.toMatchObject({ code: 6 });
    await expect(
      source.append({
        row: { ...row, unexpected: true },
        table: "audit_records",
      }),
    ).rejects.toThrow("Invalid row for component table: audit_records");
  });
});

setupUniversalComponentDataAdapterTestSuite({
  name: "Firebase universal component data conformance",
  createAdapter: createConformanceAdapter,
  dispose: () => undefined,
  readinessFailures: [
    {
      name: "physical schema drift",
      prepare: async (adapter, schema) => {
        await migrateForReadinessFailure(adapter, schema);
        await auditRecordsCollection
          .doc("stored-document-key")
          .set(conformanceRecord("declared-primary-key"));
      },
    },
    {
      name: "stored data drift",
      prepare: async (adapter, schema) => {
        await migrateForReadinessFailure(adapter, schema);
        await auditRecordsCollection.doc("stored-data-drift").set({
          ...conformanceRecord("stored-data-drift"),
          unexpected: true,
        });
      },
    },
    {
      name: "index drift",
      prepare: async (adapter, schema) => {
        await migrateForReadinessFailure(adapter, schema);
        conformanceIndexError = new Error("missing declared Firebase index");
      },
    },
  ],
  reset: async () => {
    conformanceIndexError = null;
    await clearCollections();
  },
  setStoredVersion: async (_adapter, schema, version) => {
    await settingsCollection
      .doc(getUniversalComponentSchemaMarkerKey(schema))
      .set({ value: version });
  },
});

class FirebaseComponentIndexDriftError extends Error {
  readonly name = "FirebaseComponentIndexDriftError";
}

class FirebaseComponentMarkerWriteTestError extends Error {
  readonly name = "FirebaseComponentMarkerWriteTestError";
}

const rawSetting = async (key: string): Promise<unknown> => {
  const document = await settingsCollection.doc(key).get();
  return document.exists ? document.data()?.value : null;
};

const createMigrationHarness =
  async (): Promise<UniversalComponentMigrationTestHarness> => {
    let indexesReady = true;
    let seededPhysicalState: SyntheticUniversalComponentMigrationState["physicalState"] =
      "absent";
    let batchFactory: ReturnType<typeof vi.spyOn> | undefined;
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
      selectPhysicalVersion: (compatibleVersions) => {
        const selected =
          seededPhysicalState === "absent"
            ? null
            : seededPhysicalState === "version-1"
              ? "1"
              : seededPhysicalState === "version-2"
                ? "2"
                : compatibleVersions[0]!;
        return selected;
      },
      validateIndexes: async () => {
        if (!indexesReady) throw new FirebaseComponentIndexDriftError();
      },
    });
    return {
      adapter,
      dispose() {
        batchFactory?.mockRestore();
      },
      async failNextMarkerWrite() {
        const batch = firestore.batch();
        vi.spyOn(batch, "commit").mockRejectedValueOnce(
          new FirebaseComponentMarkerWriteTestError(),
        );
        batchFactory = vi.spyOn(firestore, "batch").mockReturnValueOnce(batch);
      },
      async inspect(): Promise<SyntheticUniversalComponentMigrationState> {
        const [componentVersion, legacyVersion, rowsSnapshot] =
          await Promise.all([
            rawSetting("schema.audit-history"),
            rawSetting("version"),
            auditHistoryRecordsCollection.orderBy("id", "asc").get(),
          ]);
        const rows = rowsSnapshot.docs.map((document) => document.data());
        const physicalState = !indexesReady
          ? "drift"
          : componentVersion === "2"
            ? "version-2"
            : seededPhysicalState;
        return {
          componentVersion,
          legacyVersion,
          physicalState,
          rows,
        };
      },
      async seed(_schema, state) {
        await clearCollections();
        seededPhysicalState = state.physicalState;
        indexesReady = state.physicalState !== "drift";
        if (state.componentVersion !== null) {
          await settingsCollection
            .doc("schema.audit-history")
            .set({ value: state.componentVersion });
        }
        if (state.legacyVersion !== null) {
          await settingsCollection
            .doc("version")
            .set({ value: state.legacyVersion });
        }
        await Promise.all(
          state.rows.map(async (value, index) => {
            const row = value as Record<string, unknown>;
            const id = typeof row.id === "string" ? row.id : `row-${index}`;
            await auditHistoryRecordsCollection.doc(id).set(row);
          }),
        );
      },
    };
  };

setupUniversalComponentMigrationTestSuite({
  name: "Firebase universal component migration conformance",
  createHarness: createMigrationHarness,
  supportsArtifacts: true,
  supportsMarkerWriteFailure: true,
});

describe("Firebase universal component migration validation", () => {
  beforeEach(clearCollections);

  it.each([
    syntheticMigrationLegacyEvidence.version1,
    syntheticMigrationLegacyEvidence.version2,
  ])(
    "adopts an empty schemaless store with legacy evidence %s",
    async (legacyVersion) => {
      await settingsCollection.doc("version").set({ value: legacyVersion });
      const validateIndexes = vi.fn(async () => undefined);
      const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
        validateIndexes,
      });

      await expect(
        adapter.migrate?.(syntheticAuditLogMigrationSchema),
      ).resolves.toEqual({ changed: true, version: "2" });
      expect(
        (await settingsCollection.doc("schema.audit-history").get()).data(),
      ).toEqual({ value: "2" });
      expect(validateIndexes).toHaveBeenCalledTimes(1);
      expect(validateIndexes).toHaveBeenCalledWith(
        syntheticAuditLogMigrationSchema,
        "2",
      );
      expect((await auditHistoryRecordsCollection.get()).empty).toBe(true);
    },
  );

  it.each([
    {
      name: "a mismatched document key",
      documentId: "wrong-key",
      row: syntheticMigrationV2Row,
    },
    {
      name: "an extra field",
      documentId: syntheticMigrationV2Row.id as string,
      row: { ...syntheticMigrationV2Row, unexpected: true },
    },
  ])("rejects $name before writing the marker", async ({ documentId, row }) => {
    await settingsCollection.doc("version").set({
      value: syntheticMigrationLegacyEvidence.version2,
    });
    await auditHistoryRecordsCollection.doc(documentId).set(row);
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
      validateIndexes: async () => undefined,
    });

    await expect(
      adapter.migrate?.(syntheticAuditLogMigrationSchema),
    ).rejects.toBeDefined();
    expect(
      (await settingsCollection.doc("schema.audit-history").get()).exists,
    ).toBe(false);
  });

  it.each([
    {
      actorId: "actor-legacy",
      id: "event-legacy",
      legacyVersion: syntheticMigrationLegacyEvidence.version1,
    },
    {
      actorId: null,
      id: "event-current",
      legacyVersion: syntheticMigrationLegacyEvidence.version2,
    },
    {
      actorId: "actor-overlap",
      id: "event-overlap",
      legacyVersion: syntheticMigrationLegacyEvidence.version2,
    },
  ])(
    "preserves logical non-UUID ids while adopting $id",
    async ({ actorId, id, legacyVersion }) => {
      const row = {
        action: "configuration-read",
        actor_id: actorId,
        id,
        recorded_at_ms: 1,
      };
      await settingsCollection.doc("version").set({ value: legacyVersion });
      await auditHistoryRecordsCollection.doc(id).set(row);
      const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
        validateIndexes: async () => undefined,
      });

      await expect(
        adapter.migrate?.(syntheticAuditLogMigrationSchema),
      ).resolves.toEqual({ changed: true, version: "2" });
      expect(
        (await auditHistoryRecordsCollection.doc(id).get()).data(),
      ).toEqual(row);
    },
  );

  it("appends a logical non-UUID id after migration", async () => {
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
      validateIndexes: async () => undefined,
    });
    await adapter.migrate?.(syntheticAuditLogMigrationSchema);
    const row = {
      action: "anonymous-read",
      actor_id: null,
      id: "event-appended",
      recorded_at_ms: 2,
    };

    await adapter.bind(syntheticAuditLogMigrationSchema).append({
      row,
      table: "audit_history_records",
    });

    expect(
      (await auditHistoryRecordsCollection.doc("event-appended").get()).data(),
    ).toEqual(row);
  });
});
