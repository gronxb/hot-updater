import {
  defineUniversalComponentSchema,
  getUniversalComponentLatestSchema,
  type UniversalComponentDataAdapter,
  type UniversalComponentRow,
  type UniversalComponentSchema,
  UniversalComponentDataNotReadyError,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Awaitable<T> = Promise<T> | T;

export type UniversalComponentDataAdapterTestSuiteOptions = {
  readonly name: string;
  readonly createAdapter: () => Awaitable<UniversalComponentDataAdapter>;
  readonly dispose: (adapter: UniversalComponentDataAdapter) => Awaitable<void>;
  /** Removes component rows and schema markers created by earlier tests. */
  readonly reset: (adapter: UniversalComponentDataAdapter) => Awaitable<void>;
  /**
   * Applies schema state for adapters whose migration is performed outside the
   * runtime adapter. Defaults to `adapter.migrate(schema)`.
   */
  readonly migrate?: (
    adapter: UniversalComponentDataAdapter,
    schema: UniversalComponentSchema,
  ) => Awaitable<unknown>;
  /** Optional provider-test hook for seeding a stored future marker. */
  readonly setStoredVersion?: (
    adapter: UniversalComponentDataAdapter,
    schema: UniversalComponentSchema,
    version: string,
  ) => Awaitable<void>;
  /**
   * Optional provider fixtures that prepare a latest-marker state with one
   * declared physical, stored-data, or index readiness invariant broken.
   * Preparation must not call bind().assertReady(), so adapter caches remain
   * cold for the assertion.
   */
  readonly readinessFailures?: readonly {
    readonly name: string;
    readonly prepare: (
      adapter: UniversalComponentDataAdapter,
      schema: UniversalComponentSchema,
    ) => Awaitable<void>;
  }[];
};

const auditColumns = [
  { name: "id", type: "string", primaryKey: true },
  { name: "recorded_at_ms", type: "integer" },
  { name: "action", type: "string" },
  { name: "actor_id", type: "string", nullable: true },
  { name: "accepted", type: "boolean" },
  { name: "risk_score", type: "float" },
  { name: "payload", type: "json" },
] as const;

const schemaFor = (input: {
  readonly id: string;
  readonly index: string;
  readonly table: string;
}): UniversalComponentSchema =>
  defineUniversalComponentSchema({
    id: input.id,
    versions: [
      {
        version: "1",
        tables: [
          {
            name: input.table,
            columns: auditColumns,
            indexes: [
              {
                name: input.index,
                columns: ["recorded_at_ms", "id"],
              },
            ],
          },
        ],
        orderedScans: [
          {
            name: "chronological",
            table: input.table,
            columns: ["recorded_at_ms", "id"],
          },
        ],
      },
    ],
  });

export const syntheticAuditLogSchema = schemaFor({
  id: "audit-log",
  index: "audit_records_chronological_idx",
  table: "audit_records",
});

export const syntheticSecurityLogSchema = schemaFor({
  id: "security-log",
  index: "security_records_chronological_idx",
  table: "security_records",
});

const auditRow = (
  id: string,
  recordedAtMs: number,
  action = `action-${id}`,
): UniversalComponentRow => ({
  accepted: true,
  action,
  actor_id: null,
  id,
  payload: {
    attempts: 2,
    context: ["mobile", true, null, { release: "1.2.3" }],
  },
  recorded_at_ms: recordedAtMs,
  risk_score: 0.25,
});

const scan = (
  adapter: UniversalComponentDataAdapter,
  schema: UniversalComponentSchema,
  input: {
    readonly afterExclusive?: readonly [number, string];
    readonly beforePrefixExclusive: readonly [number];
    readonly limit?: number;
  },
) =>
  adapter.bind(schema).orderedScan({
    accessPattern: "chronological",
    ...(input.afterExclusive ? { afterExclusive: input.afterExclusive } : {}),
    beforePrefixExclusive: input.beforePrefixExclusive,
    limit: input.limit ?? 100,
  });

export const setupUniversalComponentDataAdapterTestSuite = (
  options: UniversalComponentDataAdapterTestSuiteOptions,
): void => {
  describe(options.name, () => {
    let adapter: UniversalComponentDataAdapter | undefined;

    const getAdapter = (): UniversalComponentDataAdapter => {
      if (adapter === undefined) {
        throw new TypeError(
          "The universal component data adapter is unavailable outside the test lifecycle.",
        );
      }
      return adapter;
    };

    const migrate = async (schema = syntheticAuditLogSchema) => {
      const current = getAdapter();
      if (options.migrate !== undefined) {
        await options.migrate(current, schema);
        return;
      }
      if (current.migrate === undefined) {
        throw new TypeError(
          `${options.name} must provide a migration hook or adapter.migrate().`,
        );
      }
      await current.migrate(schema);
    };

    const readySource = async (schema = syntheticAuditLogSchema) => {
      await migrate(schema);
      const source = getAdapter().bind(schema);
      await source.assertReady();
      return source;
    };

    beforeEach(async () => {
      adapter = await options.createAdapter();
      await options.reset(adapter);
    });

    afterEach(async () => {
      if (adapter !== undefined) {
        await options.dispose(adapter);
        adapter = undefined;
      }
    });

    it("fails closed before the component schema is ready", async () => {
      const source = getAdapter().bind(syntheticAuditLogSchema);
      const row = auditRow("not-ready", 1);

      await expect(source.assertReady()).rejects.toBeInstanceOf(
        UniversalComponentSchemaNotReadyError,
      );
      await expect(
        source.append({ row, table: "audit_records" }),
      ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);
      await expect(
        source.create({ row, table: "audit_records" }),
      ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);
      await expect(
        source.get({ primaryKey: row.id as string, table: "audit_records" }),
      ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);
      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          beforePrefixExclusive: [2],
        }),
      ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);

      await migrate();
      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          beforePrefixExclusive: [2],
        }),
      ).resolves.toEqual([]);
    });

    it.each(options.readinessFailures ?? [])(
      "classifies marker-latest $name readiness failures across every operation",
      async ({ prepare }) => {
        const current = getAdapter();
        await prepare(current, syntheticAuditLogSchema);
        const source = current.bind(syntheticAuditLogSchema);
        const expectedVersion = getUniversalComponentLatestSchema(
          syntheticAuditLogSchema,
        ).version;
        const expectNotReady = async (operation: Promise<unknown>) => {
          await expect(operation).rejects.toBeInstanceOf(
            UniversalComponentDataNotReadyError,
          );
          await expect(operation).rejects.toMatchObject({
            componentId: syntheticAuditLogSchema.id,
            expectedVersion,
          });
        };

        await expectNotReady(source.assertReady());
        await expectNotReady(
          source.append({
            row: auditRow("not-ready", 1),
            table: "audit_records",
          }),
        );
        await expectNotReady(
          source.create({
            row: auditRow("not-ready", 1),
            table: "audit_records",
          }),
        );
        await expectNotReady(
          source.get({
            primaryKey: "not-ready",
            table: "audit_records",
          }),
        );
        await expectNotReady(
          source.orderedScan({
            accessPattern: "chronological",
            beforePrefixExclusive: [2],
            limit: 100,
          }),
        );
      },
    );

    it("round-trips arbitrary JSON-compatible component rows", async () => {
      const source = await readySource();
      const row = auditRow("json-row", 1);

      await source.append({ row, table: "audit_records" });

      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          beforePrefixExclusive: [2],
        }),
      ).resolves.toEqual([row]);
    });

    it("creates by primary key without overwriting and gets exact rows", async () => {
      const source = await readySource();
      const original = auditRow("create-once", 1, "original");
      const replacement = auditRow("create-once", 2, "replacement");

      await expect(
        source.create({ row: original, table: "audit_records" }),
      ).resolves.toBe("created");
      await expect(
        source.create({ row: replacement, table: "audit_records" }),
      ).resolves.toBe("existing");
      await expect(
        source.get({ primaryKey: "create-once", table: "audit_records" }),
      ).resolves.toEqual(original);
      await expect(
        source.get({ primaryKey: "missing", table: "audit_records" }),
      ).resolves.toBeNull();
    });

    it("scans in ascending tuple order with a stable id tie-break", async () => {
      const source = await readySource();
      const rows = [
        auditRow("record-d", 3),
        auditRow("record-c", 2),
        auditRow("record-a", 1),
        auditRow("record-b", 2),
      ];
      for (const row of rows) {
        await source.append({ row, table: "audit_records" });
      }

      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          beforePrefixExclusive: [4],
        }),
      ).resolves.toEqual([rows[2], rows[3], rows[1], rows[0]]);
    });

    it("uses an exclusive full-tuple cursor", async () => {
      const source = await readySource();
      const rows = [
        auditRow("record-a", 1),
        auditRow("record-b", 2),
        auditRow("record-c", 2),
        auditRow("record-d", 3),
      ];
      for (const row of rows) {
        await source.append({ row, table: "audit_records" });
      }

      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          afterExclusive: [2, "record-b"],
          beforePrefixExclusive: [4],
        }),
      ).resolves.toEqual(rows.slice(2));
    });

    it("excludes every row at the upper-bound prefix", async () => {
      const source = await readySource();
      const rows = [
        auditRow("record-a", 1),
        auditRow("record-b", 2),
        auditRow("record-c", 3),
        auditRow("record-d", 3),
      ];
      for (const row of rows) {
        await source.append({ row, table: "audit_records" });
      }

      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          beforePrefixExclusive: [3],
        }),
      ).resolves.toEqual(rows.slice(0, 2));
    });

    it("returns no more than the requested limit", async () => {
      const source = await readySource();
      const rows = [
        auditRow("record-a", 1),
        auditRow("record-b", 2),
        auditRow("record-c", 3),
      ];
      for (const row of rows) {
        await source.append({ row, table: "audit_records" });
      }

      const result = await scan(getAdapter(), syntheticAuditLogSchema, {
        beforePrefixExclusive: [4],
        limit: 2,
      });

      expect(result).toEqual(rows.slice(0, 2));
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("isolates rows across component tables and named access patterns", async () => {
      const auditSource = await readySource(syntheticAuditLogSchema);
      const securitySource = await readySource(syntheticSecurityLogSchema);
      const audit = auditRow("shared-id", 1, "audit-action");
      const security = auditRow("shared-id", 1, "security-action");

      await auditSource.append({ row: audit, table: "audit_records" });
      await securitySource.append({
        row: security,
        table: "security_records",
      });

      await expect(
        auditSource.get({
          primaryKey: "shared-id",
          table: "audit_records",
        }),
      ).resolves.toEqual(audit);
      await expect(
        securitySource.get({
          primaryKey: "shared-id",
          table: "security_records",
        }),
      ).resolves.toEqual(security);

      await expect(
        scan(getAdapter(), syntheticAuditLogSchema, {
          beforePrefixExclusive: [2],
        }),
      ).resolves.toEqual([audit]);
      await expect(
        scan(getAdapter(), syntheticSecurityLogSchema, {
          beforePrefixExclusive: [2],
        }),
      ).resolves.toEqual([security]);
    });

    const setStoredVersion = options.setStoredVersion;
    if (setStoredVersion !== undefined) {
      it("rejects a future marker without overwriting it", async () => {
        const futureVersion = "999";
        await setStoredVersion(
          getAdapter(),
          syntheticAuditLogSchema,
          futureVersion,
        );
        const source = getAdapter().bind(syntheticAuditLogSchema);

        await expect(migrate()).rejects.toBeDefined();
        await expect(source.assertReady()).rejects.toMatchObject({
          actualVersion: futureVersion,
          componentId: syntheticAuditLogSchema.id,
          expectedVersion: getUniversalComponentLatestSchema(
            syntheticAuditLogSchema,
          ).version,
        });
      });
    }
  });
};
