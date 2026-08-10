import { PGlite } from "@electric-sql/pglite";
import {
  defineUniversalComponentSchema,
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  UniversalComponentSchemaNotReadyError,
  universalComponentDataAdapterCapability,
  type DatabasePlugin,
  type UniversalComponentDataAdapter,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import {
  setupUniversalComponentDataAdapterTestSuite,
  syntheticAuditLogSchema,
  syntheticSecurityLogSchema,
} from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { postgres } from "./postgres";

const nullableJsonSchema = defineUniversalComponentSchema({
  id: "nullable-json-test",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "nullable_json_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "payload", type: "json", nullable: true },
          ],
        },
      ],
    },
  ],
});

const releasedPlainCheckSchema = defineUniversalComponentSchema({
  id: "released-plain-check",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "released_plain_check_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "value", type: "string", nullable: true },
          ],
          checks: [
            {
              name: "released_plain_value_check",
              expression: { column: "value", op: "non-empty" },
            },
          ],
        },
      ],
    },
  ],
});

const validationOnlySchema = defineUniversalComponentSchema({
  id: "validation-only-check",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "validation_only_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "state", type: "string" },
          ],
        },
      ],
      orderedScans: [
        {
          name: "by_id",
          table: "validation_only_records",
          columns: ["id"],
        },
      ],
    },
    {
      version: "2",
      tables: [
        {
          name: "validation_only_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "state", type: "string" },
          ],
          checks: [
            {
              enforcement: "validation",
              name: "validation_only_state_check",
              expression: {
                column: "state",
                op: "in",
                values: ["valid"],
              },
            },
          ],
        },
      ],
      orderedScans: [
        {
          name: "by_id",
          table: "validation_only_records",
          columns: ["id"],
        },
      ],
    },
  ],
});

const validationOnlyV1Schema = defineUniversalComponentSchema({
  id: validationOnlySchema.id,
  versions: [validationOnlySchema.versions[0]],
});

const sourcePreflightSchema = defineUniversalComponentSchema({
  id: "source-preflight-check",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "source_preflight_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "state", type: "string" },
          ],
          checks: [
            {
              enforcement: "validation",
              name: "source_preflight_state_v1",
              expression: { column: "state", op: "eq", value: "old" },
            },
          ],
          indexes: [
            {
              name: "source_preflight_v1_idx",
              columns: ["state", "id"],
            },
          ],
        },
      ],
    },
    {
      version: "2",
      tables: [
        {
          name: "source_preflight_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "state", type: "string" },
          ],
          indexes: [
            {
              name: "source_preflight_v2_idx",
              columns: ["state", "id"],
            },
          ],
        },
      ],
    },
  ],
});

const sourcePreflightV1Schema = defineUniversalComponentSchema({
  id: sourcePreflightSchema.id,
  versions: [sourcePreflightSchema.versions[0]],
});

const uuidNonEmptySchema = defineUniversalComponentSchema({
  id: "uuid-non-empty-check",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "uuid_non_empty_records",
          columns: [{ name: "id", type: "uuid", primaryKey: true }],
          checks: [
            {
              name: "uuid_non_empty_id_check",
              expression: { column: "id", op: "non-empty" },
            },
          ],
        },
      ],
    },
  ],
});

const preservationSchema = defineUniversalComponentSchema({
  id: "preservation-log",
  unmarked: {
    adopt: [
      { version: "1", when: ["legacy-v1"] },
      { version: "2", when: ["legacy-v2"] },
    ],
    createWhen: [null],
    discriminatorKey: "legacy.preservation-log",
    knownValues: [null, "legacy-v1", "legacy-v2", "blocked"],
  },
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "preservation_records",
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "kind", type: "string" },
            { name: "prior_id", type: "uuid" },
            { name: "strategy", type: "string" },
            { name: "recorded_at_ms", type: "float" },
            { name: "payload", type: "json", nullable: true },
          ],
          checks: [
            {
              name: "preservation_kind_v1_check",
              expression: {
                column: "kind",
                op: "in",
                values: ["APPLIED", "RECOVERED"],
              },
            },
            {
              name: "preservation_strategy_v1_check",
              expression: {
                column: "strategy",
                op: "in",
                values: ["fingerprint", "appVersion"],
              },
            },
          ],
          indexes: [
            {
              name: "preservation_chronological_idx",
              columns: ["recorded_at_ms", "id"],
            },
          ],
        },
      ],
    },
    {
      version: "2",
      tables: [
        {
          name: "preservation_records",
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "kind", type: "string" },
            { name: "prior_id", type: "uuid", nullable: true },
            { name: "strategy", type: "string", nullable: true },
            { name: "recorded_at_ms", type: "float" },
            { name: "payload", type: "json", nullable: true },
          ],
          checks: [
            {
              name: "preservation_kind_v2_check",
              expression: {
                column: "kind",
                op: "in",
                values: ["APPLIED", "RECOVERED", "UNCHANGED"],
              },
            },
            {
              name: "preservation_strategy_v2_check",
              expression: {
                op: "any",
                expressions: [
                  { column: "strategy", op: "is-null" },
                  {
                    column: "strategy",
                    op: "in",
                    values: ["fingerprint", "appVersion"],
                  },
                ],
              },
            },
            {
              name: "preservation_shape_v2_check",
              expression: {
                op: "any",
                expressions: [
                  {
                    op: "all",
                    expressions: [
                      {
                        column: "kind",
                        op: "in",
                        values: ["APPLIED", "RECOVERED"],
                      },
                      { column: "prior_id", op: "is-not-null" },
                      { column: "strategy", op: "is-not-null" },
                    ],
                  },
                  {
                    op: "all",
                    expressions: [
                      { column: "kind", op: "eq", value: "UNCHANGED" },
                      { column: "prior_id", op: "is-null" },
                      { column: "strategy", op: "is-null" },
                    ],
                  },
                ],
              },
            },
            {
              name: "preservation_recorded_at_v2_check",
              expression: {
                op: "all",
                expressions: [
                  { column: "recorded_at_ms", op: "gte", value: 0 },
                  { column: "recorded_at_ms", op: "integer" },
                ],
              },
            },
          ],
          indexes: [
            {
              name: "preservation_chronological_idx",
              columns: ["recorded_at_ms", "id"],
            },
            {
              name: "preservation_kind_idx",
              columns: ["kind", "recorded_at_ms", "id"],
            },
          ],
        },
      ],
    },
  ],
});

const preservationV1Schema = defineUniversalComponentSchema({
  id: preservationSchema.id,
  versions: [preservationSchema.versions[0]],
});

const preservationRow = (recordedAtMs = 1) => ({
  id: "00000000-0000-0000-0000-000000000011",
  kind: "APPLIED",
  payload: { source: "synthetic", tags: ["preserved", true] },
  prior_id: "00000000-0000-0000-0000-000000000001",
  recorded_at_ms: recordedAtMs,
  strategy: "appVersion",
});

let client: PGlite | undefined;
let plugin: DatabasePlugin | undefined;

const getClient = (): PGlite => {
  if (client === undefined) throw new TypeError("PGlite is not initialized");
  return client;
};

const resolveAdapter = async (): Promise<UniversalComponentDataAdapter> => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE private_hot_updater_settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
  `);
  plugin = postgres({ dialect: new PGliteDialect(client) });
  const contribution = getCapabilityContributions(plugin).find(
    ({ token }) => token.id === universalComponentDataAdapterCapability.id,
  );
  if (contribution === undefined) {
    throw new TypeError(
      "Postgres component data adapter capability is missing",
    );
  }
  return universalComponentDataAdapterCapability.parse(
    contribution.create({ database: plugin, storages: [] }),
  );
};

const componentIds = [
  syntheticAuditLogSchema.id,
  syntheticSecurityLogSchema.id,
] as const;

setupUniversalComponentDataAdapterTestSuite({
  name: "postgres universal component data adapter",
  createAdapter: resolveAdapter,
  async reset() {
    await getClient().exec(`
      DROP TABLE IF EXISTS audit_records;
      DROP TABLE IF EXISTS security_records;
      DELETE FROM private_hot_updater_settings
      WHERE key IN (${componentIds.map((id) => `'schema.${id}'`).join(", ")});
    `);
  },
  async dispose() {
    await plugin?.onUnmount?.();
    plugin = undefined;
    client = undefined;
  },
  async setStoredVersion(_adapter, schema, version) {
    await getClient().query(
      `INSERT INTO private_hot_updater_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`schema.${schema.id}`, version],
    );
  },
});

describe("postgres universal component physical schema validation", () => {
  let adapter: UniversalComponentDataAdapter | undefined;

  const migrateAuditSchema = async (): Promise<void> => {
    if (adapter?.migrate === undefined) {
      throw new TypeError("Postgres component data migration is unavailable");
    }
    await adapter.migrate(syntheticAuditLogSchema);
  };

  const auditMarker = async (): Promise<string | null> => {
    const result = await getClient().query<{ value: string }>(
      `SELECT value FROM private_hot_updater_settings WHERE key = $1`,
      [getUniversalComponentSchemaMarkerKey(syntheticAuditLogSchema)],
    );
    return result.rows[0]?.value ?? null;
  };

  beforeEach(async () => {
    adapter = await resolveAdapter();
  });

  afterEach(async () => {
    await plugin?.onUnmount?.();
    adapter = undefined;
    plugin = undefined;
    client = undefined;
  });

  it("does not mark an existing table that is missing a declared column", async () => {
    await getClient().exec(`
      CREATE TABLE audit_records (
        id text PRIMARY KEY,
        recorded_at_ms bigint NOT NULL,
        action text NOT NULL,
        actor_id text,
        accepted boolean NOT NULL,
        risk_score double precision NOT NULL
      );
      CREATE INDEX audit_records_chronological_idx
      ON audit_records (recorded_at_ms, id);
    `);

    await expect(migrateAuditSchema()).rejects.toThrow(
      "table audit_records has 6 columns; expected 7",
    );
    await expect(auditMarker()).resolves.toBeNull();
  });

  it("does not mark an existing table with incompatible nullability", async () => {
    await getClient().exec(`
      CREATE TABLE audit_records (
        id text PRIMARY KEY,
        recorded_at_ms bigint NOT NULL,
        action text NOT NULL,
        actor_id text NOT NULL,
        accepted boolean NOT NULL,
        risk_score double precision NOT NULL,
        payload jsonb NOT NULL
      );
      CREATE INDEX audit_records_chronological_idx
      ON audit_records (recorded_at_ms, id);
    `);

    await expect(migrateAuditSchema()).rejects.toThrow(
      "column audit_records.actor_id has not-null=true; expected false",
    );
    await expect(auditMarker()).resolves.toBeNull();
  });

  it("rejects a missing declared index without changing the current marker", async () => {
    await migrateAuditSchema();
    const expectedVersion = getUniversalComponentLatestSchema(
      syntheticAuditLogSchema,
    ).version;
    await expect(auditMarker()).resolves.toBe(expectedVersion);

    await getClient().exec("DROP INDEX audit_records_chronological_idx;");

    await expect(
      adapter?.bind(syntheticAuditLogSchema).assertReady(),
    ).rejects.toThrow(
      "table audit_records is missing index audit_records_chronological_idx",
    );
    await expect(auditMarker()).resolves.toBe(expectedVersion);
  });

  it("stores nullable JSON as SQL NULL instead of JSON null", async () => {
    if (adapter?.migrate === undefined) {
      throw new TypeError("Postgres component data migration is unavailable");
    }
    await adapter.migrate(nullableJsonSchema);
    await adapter.bind(nullableJsonSchema).append({
      table: "nullable_json_records",
      row: { id: "nullable", payload: null },
    });

    const result = await getClient().query<{ readonly is_null: boolean }>(
      "SELECT payload IS NULL AS is_null FROM nullable_json_records",
    );

    expect(result.rows).toEqual([{ is_null: true }]);
  });
});

describe("postgres universal component schema preservation", () => {
  let adapter: UniversalComponentDataAdapter | undefined;

  const getAdapter = (): UniversalComponentDataAdapter => {
    if (adapter === undefined)
      throw new TypeError("Adapter is not initialized");
    return adapter;
  };

  const migrate = async (
    schema = preservationSchema,
  ): Promise<{ readonly changed: boolean; readonly version: string }> => {
    const migration = getAdapter().migrate;
    if (migration === undefined) {
      throw new TypeError("Postgres component data migration is unavailable");
    }
    return migration(schema);
  };

  const artifactFor = (schema = preservationSchema): string => {
    const artifact = getAdapter().artifacts?.(schema)[0];
    if (artifact === undefined) {
      throw new TypeError("Postgres component artifact is unavailable");
    }
    return artifact.contents;
  };

  const executeFailedArtifact = async (
    schema = preservationSchema,
  ): Promise<unknown> => {
    let failure: unknown;
    try {
      await getClient().exec(artifactFor(schema));
    } catch (error) {
      failure = error;
      await getClient().exec("ROLLBACK;");
    }
    expect(failure).toBeDefined();
    return failure;
  };

  const marker = async (): Promise<string | null> => {
    const result = await getClient().query<{ readonly value: string }>(
      "SELECT value FROM private_hot_updater_settings WHERE key = $1",
      [getUniversalComponentSchemaMarkerKey(preservationSchema)],
    );
    return result.rows[0]?.value ?? null;
  };

  const setSetting = async (key: string, value: string): Promise<void> => {
    await getClient().query(
      `INSERT INTO private_hot_updater_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  };

  const removeMarker = async (): Promise<void> => {
    await getClient().query(
      "DELETE FROM private_hot_updater_settings WHERE key = $1",
      [getUniversalComponentSchemaMarkerKey(preservationSchema)],
    );
  };

  beforeEach(async () => {
    adapter = await resolveAdapter();
  });

  afterEach(async () => {
    await plugin?.onUnmount?.();
    adapter = undefined;
    plugin = undefined;
    client = undefined;
  });

  it("migrates exact v1 to v2 while preserving UUID and JSON rows", async () => {
    await migrate(preservationV1Schema);
    const row = preservationRow();
    await getAdapter().bind(preservationV1Schema).append({
      row,
      table: "preservation_records",
    });

    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });
    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).resolves.toBeUndefined();
    await expect(marker()).resolves.toBe("2");

    const stored = await getClient().query(
      "SELECT * FROM preservation_records ORDER BY id",
    );
    expect(stored.rows).toEqual([row]);
  });

  it.each([
    { discriminator: "legacy-v1", physical: "1" },
    { discriminator: "legacy-v2", physical: "2" },
  ])(
    "adopts allowed unmarked exact v$physical and reaches v2",
    async ({ discriminator, physical }) => {
      await migrate(
        physical === "1" ? preservationV1Schema : preservationSchema,
      );
      await setSetting("legacy.preservation-log", discriminator);
      await removeMarker();

      await expect(migrate()).resolves.toEqual({
        changed: true,
        version: "2",
      });
      await expect(marker()).resolves.toBe("2");
    },
  );

  it("rejects an unmarked exact version not allowed by its discriminator", async () => {
    await migrate(preservationV1Schema);
    await setSetting("legacy.preservation-log", "legacy-v2");
    await removeMarker();

    await expect(migrate()).rejects.toThrow("migration state is not adoptable");
    await expect(marker()).resolves.toBeNull();
    await expect(
      getAdapter().bind(preservationV1Schema).assertReady(),
    ).rejects.toBeInstanceOf(Error);
  });

  it("adopts the released plain CHECK catalog shape", async () => {
    await getClient().exec(`
      CREATE TABLE released_plain_check_records (
        id text PRIMARY KEY,
        value text,
        CONSTRAINT released_plain_value_check
        CHECK (char_length(value) > 0)
      );
      INSERT INTO released_plain_check_records (id, value)
      VALUES ('released', 'valid');
    `);

    await expect(migrate(releasedPlainCheckSchema)).resolves.toEqual({
      changed: true,
      version: "1",
    });
    await expect(
      getAdapter().bind(releasedPlainCheckSchema).assertReady(),
    ).resolves.toBeUndefined();
    const constraints = await getClient().query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint
      WHERE conname = 'released_plain_value_check'
    `);
    expect(constraints.rows).toEqual([
      { definition: "CHECK (char_length(value) > 0)" },
    ]);
  });

  it("validates corrupt rows once, retries failures, and keeps polling the marker", async () => {
    await migrate(releasedPlainCheckSchema);
    await getClient().exec(`
      INSERT INTO released_plain_check_records (id, value)
      VALUES ('readiness', 'valid');
    `);
    const source = getAdapter().bind(releasedPlainCheckSchema);

    await expect(source.assertReady()).resolves.toBeUndefined();
    await expect(migrate(releasedPlainCheckSchema)).resolves.toEqual({
      changed: false,
      version: "1",
    });
    await getClient().exec(`
      UPDATE released_plain_check_records
      SET value = NULL
      WHERE id = 'readiness';
    `);
    await expect(source.assertReady()).rejects.toThrow(
      "Invalid row for component table: released_plain_check_records@1",
    );

    await getClient().exec(`
      UPDATE released_plain_check_records
      SET value = 'repaired'
      WHERE id = 'readiness';
    `);
    await expect(source.assertReady()).resolves.toBeUndefined();
    await getClient().exec(`
      UPDATE released_plain_check_records
      SET value = NULL
      WHERE id = 'readiness';
    `);
    await expect(source.assertReady()).resolves.toBeUndefined();

    await getClient().query(
      "DELETE FROM private_hot_updater_settings WHERE key = $1",
      [getUniversalComponentSchemaMarkerKey(releasedPlainCheckSchema)],
    );
    await expect(source.assertReady()).rejects.toBeInstanceOf(
      UniversalComponentSchemaNotReadyError,
    );
  });

  it("validates validation-only checks without storing a constraint", async () => {
    await migrate(validationOnlyV1Schema);
    await getClient().exec(`
      INSERT INTO validation_only_records (id, state)
      VALUES ('validation-only', 'invalid');
    `);

    await expect(migrate(validationOnlySchema)).rejects.toThrow(
      "Invalid row for component table: validation_only_records@2",
    );
    await getClient().exec(`
      UPDATE validation_only_records
      SET state = 'valid'
      WHERE id = 'validation-only';
    `);
    await expect(migrate(validationOnlySchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });
    const constraints = await getClient().query<{ name: string }>(`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conrelid = 'validation_only_records'::regclass
        AND contype = 'c'
    `);
    expect(constraints.rows).toEqual([]);
    expect(
      getAdapter().artifacts?.(validationOnlySchema)[0]?.contents,
    ).not.toContain("validation_only_state_check");
  });

  it("rejects validation-only corruption returned after readiness is cached", async () => {
    await migrate(validationOnlySchema);
    const source = getAdapter().bind(validationOnlySchema);
    await expect(source.assertReady()).resolves.toBeUndefined();
    await getClient().exec(`
      INSERT INTO validation_only_records (id, state)
      VALUES ('externally-corrupt', 'invalid');
    `);

    await expect(
      source.orderedScan({
        accessPattern: "by_id",
        beforePrefixExclusive: ["z"],
        limit: 10,
      }),
    ).rejects.toThrow(
      "Invalid row for component table: validation_only_records@2",
    );
  });

  it("artifact migrates exact v1 to v2 and preserves UUID rows", async () => {
    await migrate(preservationV1Schema);
    const row = preservationRow();
    await getAdapter().bind(preservationV1Schema).append({
      row,
      table: "preservation_records",
    });

    await getClient().exec(artifactFor());

    const stored = await getClient().query(
      "SELECT * FROM preservation_records ORDER BY id",
    );
    expect(stored.rows).toEqual([row]);
    await expect(marker()).resolves.toBe("2");
    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).resolves.toBeUndefined();
  });

  it("artifact adopts exact v2 and repairs a stale marker", async () => {
    await migrate();
    await getClient().exec(`
      INSERT INTO preservation_records (
        id, kind, prior_id, strategy, recorded_at_ms, payload
      ) VALUES (
        '00000000-0000-0000-0000-000000000099',
        'UNCHANGED',
        NULL,
        NULL,
        99,
        '{}'::jsonb
      );
    `);
    await setSetting("legacy.preservation-log", "legacy-v2");
    await removeMarker();

    await getClient().exec(artifactFor());
    await expect(marker()).resolves.toBe("2");
    await setSetting(
      getUniversalComponentSchemaMarkerKey(preservationSchema),
      "1",
    );
    await getClient().exec(artifactFor());

    await expect(marker()).resolves.toBe("2");
    const count = await getClient().query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM preservation_records",
    );
    expect(count.rows).toEqual([{ count: 1 }]);
  });

  it("artifact rejects declaratively forbidden unmarked state", async () => {
    await migrate(preservationV1Schema);
    await setSetting("legacy.preservation-log", "legacy-v2");
    await removeMarker();

    const failure = await executeFailedArtifact();

    expect((failure as Error).message).toContain(
      "migration state is incompatible",
    );
    await expect(marker()).resolves.toBeNull();
    const nullable = await getClient().query<{ is_nullable: string }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'preservation_records'
        AND column_name = 'prior_id'
    `);
    expect(nullable.rows).toEqual([{ is_nullable: "NO" }]);
  });

  it("artifact rejects absent state outside createWhen", async () => {
    await setSetting("legacy.preservation-log", "legacy-v2");

    const failure = await executeFailedArtifact();

    expect((failure as Error).message).toContain(
      "migration state is incompatible",
    );
    await expect(marker()).resolves.toBeNull();
    const physical = await getClient().query<{ present: boolean }>(`
      SELECT to_regclass('preservation_records') IS NOT NULL AS present
    `);
    expect(physical.rows).toEqual([{ present: false }]);
  });

  it("artifact rejects exact catalog drift before changing the marker", async () => {
    await migrate();
    await getClient().exec(`
      DROP INDEX preservation_kind_idx;
      CREATE INDEX preservation_kind_idx
      ON preservation_records (kind, id);
    `);

    const failure = await executeFailedArtifact();

    expect((failure as Error).message).toContain(
      "has unsupported physical state",
    );
    await expect(marker()).resolves.toBe("2");
  });

  it("artifact strictly rejects storage-check rows accepted by SQL null semantics", async () => {
    await getClient().exec(`
      CREATE TABLE released_plain_check_records (
        id text PRIMARY KEY,
        value text,
        CONSTRAINT released_plain_value_check
        CHECK (char_length(value) > 0)
      );
      INSERT INTO released_plain_check_records (id, value)
      VALUES ('corrupt', NULL);
    `);

    const failure = await executeFailedArtifact(releasedPlainCheckSchema);

    expect((failure as Error).message).toContain(
      "contains invalid rows in released_plain_check_records@1",
    );
    const componentMarker = await getClient().query<{ value: string }>(
      "SELECT value FROM private_hot_updater_settings WHERE key = $1",
      [getUniversalComponentSchemaMarkerKey(releasedPlainCheckSchema)],
    );
    expect(componentMarker.rows).toEqual([]);
  });

  it("artifact rejects validation-only corrupt rows without storing their constraint", async () => {
    await migrate(validationOnlyV1Schema);
    await getClient().exec(`
      INSERT INTO validation_only_records (id, state)
      VALUES ('validation-only', 'invalid');
    `);

    const failure = await executeFailedArtifact(validationOnlySchema);

    expect((failure as Error).message).toContain(
      "contains invalid rows in validation_only_records@2",
    );
    const constraints = await getClient().query<{ name: string }>(`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conrelid = 'validation_only_records'::regclass
        AND contype = 'c'
    `);
    expect(constraints.rows).toEqual([]);
  });

  it("artifact validates the source contract before a relaxing transition", async () => {
    await migrate(sourcePreflightV1Schema);
    await getClient().exec(`
      INSERT INTO source_preflight_records (id, state)
      VALUES ('source-invalid', 'new');
    `);

    const failure = await executeFailedArtifact(sourcePreflightSchema);

    expect((failure as Error).message).toContain(
      "contains invalid rows in source_preflight_records@1",
    );
    const state = await getClient().query<{
      marker: string;
      v1_index: boolean;
      v2_index: boolean;
    }>(`
      SELECT
        (
          SELECT value FROM private_hot_updater_settings
          WHERE key = 'schema.source-preflight-check'
        ) AS marker,
        to_regclass('source_preflight_v1_idx') IS NOT NULL AS v1_index,
        to_regclass('source_preflight_v2_idx') IS NOT NULL AS v2_index
    `);
    expect(state.rows).toEqual([
      { marker: "1", v1_index: true, v2_index: false },
    ]);
  });

  it("artifact rolls back an interrupted marker write, retries, and reruns", async () => {
    await migrate(preservationV1Schema);
    await getClient().exec(`
      ALTER TABLE private_hot_updater_settings
      ADD CONSTRAINT reject_artifact_preservation_v2
      CHECK (value <> '2');
    `);

    const failure = await executeFailedArtifact();
    expect(failure).toBeInstanceOf(Error);
    const interrupted = await getClient().query<{
      marker: string;
      prior_nullable: string;
      v1_check: boolean;
      v2_index: boolean;
    }>(`
      SELECT
        (
          SELECT value FROM private_hot_updater_settings
          WHERE key = 'schema.preservation-log'
        ) AS marker,
        (
          SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'preservation_records'
            AND column_name = 'prior_id'
        ) AS prior_nullable,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'preservation_kind_v1_check'
        ) AS v1_check,
        to_regclass('preservation_kind_idx') IS NOT NULL AS v2_index
    `);
    expect(interrupted.rows).toEqual([
      {
        marker: "1",
        prior_nullable: "NO",
        v1_check: true,
        v2_index: false,
      },
    ]);

    await getClient().exec(`
      ALTER TABLE private_hot_updater_settings
      DROP CONSTRAINT reject_artifact_preservation_v2;
    `);
    await getClient().exec(artifactFor());
    await getClient().exec(artifactFor());
    await expect(marker()).resolves.toBe("2");
  });

  it("artifact adopts a released plain named-check catalog", async () => {
    await getClient().exec(`
      CREATE TABLE released_plain_check_records (
        id text PRIMARY KEY,
        value text,
        CONSTRAINT released_plain_value_check
        CHECK (char_length(value) > 0)
      );
      INSERT INTO released_plain_check_records (id, value)
      VALUES ('released', 'valid');
    `);

    await getClient().exec(artifactFor(releasedPlainCheckSchema));
    await getClient().exec(artifactFor(releasedPlainCheckSchema));

    const componentMarker = await getClient().query<{ value: string }>(
      "SELECT value FROM private_hot_updater_settings WHERE key = $1",
      [getUniversalComponentSchemaMarkerKey(releasedPlainCheckSchema)],
    );
    expect(componentMarker.rows).toEqual([{ value: "1" }]);
  });

  it("artifact compiles and executes a named non-empty UUID check", async () => {
    const contents = artifactFor(uuidNonEmptySchema);
    expect(contents).toContain('char_length("id"::text) > 0');

    await getClient().exec(contents);

    const constraints = await getClient().query<{ name: string }>(`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conrelid = 'uuid_non_empty_records'::regclass
        AND contype = 'c'
    `);
    expect(constraints.rows).toEqual([{ name: "uuid_non_empty_id_check" }]);
  });

  it("validates every stored row against v2 before changing physical state", async () => {
    await migrate(preservationV1Schema);
    await getClient().exec(`
      INSERT INTO preservation_records (
        id, kind, prior_id, strategy, recorded_at_ms, payload
      )
      SELECT
        ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid,
        'APPLIED',
        '00000000-0000-0000-0000-000000000001'::uuid,
        'appVersion',
        CASE WHEN value = 1001 THEN -1 ELSE value END,
        '{}'::jsonb
      FROM generate_series(1, 1001) AS value;
    `);

    await expect(migrate()).rejects.toThrow(
      "Invalid row for component table: preservation_records@2",
    );
    await expect(marker()).resolves.toBe("1");
    await expect(
      getAdapter().bind(preservationV1Schema).assertReady(),
    ).resolves.toBeUndefined();
  });

  it("rolls back nullable, check, and index DDL when the marker write fails", async () => {
    await migrate(preservationV1Schema);
    await getClient().exec(`
      ALTER TABLE private_hot_updater_settings
      ADD CONSTRAINT reject_preservation_v2
      CHECK (value <> '2');
    `);

    await expect(migrate()).rejects.toBeDefined();
    await expect(marker()).resolves.toBe("1");
    await expect(
      getAdapter().bind(preservationV1Schema).assertReady(),
    ).resolves.toBeUndefined();

    await getClient().exec(`
      ALTER TABLE private_hot_updater_settings
      DROP CONSTRAINT reject_preservation_v2;
    `);
    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });
  });

  it("recovers an exact v2 schema whose marker remained at v1 and is idempotent", async () => {
    await migrate(preservationV1Schema);
    await getAdapter().bind(preservationV1Schema).append({
      row: preservationRow(),
      table: "preservation_records",
    });
    await migrate();
    await setSetting(
      getUniversalComponentSchemaMarkerKey(preservationSchema),
      "1",
    );

    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });
    await expect(migrate()).resolves.toEqual({ changed: false, version: "2" });
    const stored = await getClient().query(
      "SELECT * FROM preservation_records ORDER BY id",
    );
    expect(stored.rows).toEqual([preservationRow()]);
  });

  it("rejects index, native UUID, and named-check definition drift", async () => {
    await migrate();
    await getClient().exec(`
      ALTER TABLE preservation_records
      ADD CONSTRAINT preservation_unexpected_fk
      FOREIGN KEY (prior_id) REFERENCES preservation_records(id);
    `);

    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).rejects.toThrow(
      "table preservation_records has unexpected constraint preservation_unexpected_fk",
    );

    await getClient().exec(`
      ALTER TABLE preservation_records
      DROP CONSTRAINT preservation_unexpected_fk;
      DROP INDEX preservation_kind_idx;
      CREATE INDEX preservation_kind_idx
      ON preservation_records (kind, id);
    `);

    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).rejects.toThrow(
      "index preservation_kind_idx does not match its declaration",
    );

    await getClient().exec(`
      DROP INDEX preservation_kind_idx;
      CREATE INDEX preservation_kind_idx
      ON preservation_records (kind, recorded_at_ms, id);
      ALTER TABLE preservation_records
      DROP CONSTRAINT preservation_shape_v2_check;
      ALTER TABLE preservation_records
      ADD CONSTRAINT preservation_shape_v2_check CHECK (true);
    `);

    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).rejects.toThrow(
      "check preservation_shape_v2_check does not match its declaration",
    );

    await getClient().exec(`
      ALTER TABLE preservation_records
      DROP CONSTRAINT preservation_shape_v2_check;
      ALTER TABLE preservation_records
      ADD CONSTRAINT preservation_shape_v2_check CHECK (
        ((kind IN ('APPLIED', 'RECOVERED') AND prior_id IS NOT NULL
          AND strategy IS NOT NULL)
        OR (kind = 'UNCHANGED' AND prior_id IS NULL AND strategy IS NULL))
      );
      ALTER TABLE preservation_records
      ALTER COLUMN prior_id TYPE text USING prior_id::text;
    `);

    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).rejects.toThrow(
      "column preservation_records.prior_id has type text; expected uuid",
    );
  });

  it("emits a versioned self-inspecting artifact with marker last", () => {
    const [artifact] = getAdapter().artifacts?.(preservationSchema) ?? [];

    expect(artifact?.targetVersion).toBe("2");
    expect(artifact?.path).toBe(
      "component-data/preservation-log/postgres-2.sql",
    );
    expect(artifact?.contents).toContain('-- target-version: "2"');
    expect(artifact?.contents).toContain('"id" uuid NOT NULL');
    expect(artifact?.contents).toContain(
      'CONSTRAINT "preservation_shape_v2_check" CHECK',
    );
    expect(artifact?.contents).toContain("pg_catalog.pg_attribute");
    expect(artifact?.contents).toContain("migration state is incompatible");
    expect(artifact?.contents).toContain("pg_advisory_xact_lock");
    expect(
      artifact?.contents.lastIndexOf("schema.preservation-log"),
    ).toBeGreaterThan(
      artifact?.contents.indexOf("preservation_kind_idx") ?? -1,
    );
    expect(artifact?.contents.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("creates fresh createWhen state and reruns idempotently", async () => {
    const contents = artifactFor();

    await getClient().exec(contents);
    await getClient().exec(contents);

    await expect(marker()).resolves.toBe("2");
    await expect(
      getAdapter().bind(preservationSchema).assertReady(),
    ).resolves.toBeUndefined();
  });

  it("creates the settings foundation when it is absent", async () => {
    await getClient().exec("DROP TABLE private_hot_updater_settings;");

    await getClient().exec(artifactFor());

    const state = await getClient().query<{
      marker: string;
      settings: boolean;
    }>(`
      SELECT
        to_regclass('private_hot_updater_settings') IS NOT NULL AS settings,
        (
          SELECT value FROM private_hot_updater_settings
          WHERE key = 'schema.preservation-log'
        ) AS marker
    `);
    expect(state.rows).toEqual([{ marker: "2", settings: true }]);
  });

  it("accepts the released varchar settings key shape", async () => {
    await getClient().exec(`
      DROP TABLE private_hot_updater_settings;
      CREATE TABLE private_hot_updater_settings (
        key varchar(255) NOT NULL PRIMARY KEY,
        value text NOT NULL
      );
    `);

    await getClient().exec(artifactFor());

    await expect(marker()).resolves.toBe("2");
  });

  it("isolates a non-public target schema from a same-named temp table", async () => {
    await getClient().exec(`
      CREATE SCHEMA component_tenant;
      SET search_path TO component_tenant, public;
      CREATE TEMP TABLE preservation_records (sentinel text);
      INSERT INTO pg_temp.preservation_records (sentinel)
      VALUES ('untouched');
    `);

    await getClient().exec(artifactFor());

    const state = await getClient().query<{
      marker: string;
      public_table: boolean;
      target_table: boolean;
      temp_value: string;
    }>(`
      SELECT
        (
          SELECT value
          FROM component_tenant.private_hot_updater_settings
          WHERE key = 'schema.preservation-log'
        ) AS marker,
        to_regclass('public.preservation_records') IS NOT NULL
          AS public_table,
        to_regclass('component_tenant.preservation_records') IS NOT NULL
          AS target_table,
        (
          SELECT sentinel FROM pg_temp.preservation_records
        ) AS temp_value
    `);
    expect(state.rows).toEqual([
      {
        marker: "2",
        public_table: false,
        target_table: true,
        temp_value: "untouched",
      },
    ]);
  });
});
