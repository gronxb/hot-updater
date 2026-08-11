import {
  defineUniversalComponentSchema,
  type UniversalComponentArtifact,
  type UniversalComponentDataAdapter,
  type UniversalComponentRow,
  type UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import {
  setupUniversalComponentDataAdapterTestSuite,
  setupUniversalComponentMigrationTestSuite,
  syntheticAuditLogSchema,
  syntheticAuditLogMigrationSchema,
  syntheticMigrationLegacyEvidence,
  syntheticMigrationValidationOnlyCorruptRow,
  syntheticMigrationV1Row,
  syntheticSecurityLogSchema,
  type SyntheticUniversalComponentMigrationState,
} from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { d1WorkerDatabase } from "../../src/cloudflareWorkerDatabase";

const legacyCompatibleCheckSchema = defineUniversalComponentSchema({
  id: "compatibility-history",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "compatibility_records",
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "kind", type: "string" },
            { name: "previous_id", nullable: true, type: "string" },
            { name: "strategy", nullable: true, type: "string" },
          ],
          checks: [
            {
              expression: {
                column: "kind",
                op: "in",
                values: ["APPLIED", "RECOVERED", "UNCHANGED"],
              },
              name: "compatibility_kind_check",
            },
            {
              expression: {
                expressions: [
                  { column: "strategy", op: "is-null" },
                  {
                    column: "strategy",
                    op: "in",
                    values: ["fingerprint", "appVersion"],
                  },
                ],
                op: "any",
              },
              name: "compatibility_strategy_check",
            },
            {
              expression: {
                expressions: [
                  {
                    expressions: [
                      {
                        column: "kind",
                        op: "in",
                        values: ["APPLIED", "RECOVERED"],
                      },
                      { column: "previous_id", op: "is-not-null" },
                      { column: "strategy", op: "is-not-null" },
                    ],
                    op: "all",
                  },
                  {
                    expressions: [
                      {
                        column: "kind",
                        op: "eq",
                        value: "UNCHANGED",
                      },
                      { column: "previous_id", op: "is-null" },
                      { column: "strategy", op: "is-null" },
                    ],
                    op: "all",
                  },
                ],
                op: "any",
              },
              name: "compatibility_shape_check",
            },
          ],
        },
      ],
    },
  ],
});

const validationOnlyCheckSchema = defineUniversalComponentSchema({
  id: "validation-history",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "validation_records",
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "score", type: "integer" },
          ],
          checks: [
            {
              enforcement: "validation",
              expression: { column: "score", op: "gte", value: 0 },
              name: "validation_score_non_negative",
            },
          ],
        },
      ],
    },
  ],
});

const resolveAdapterFromPlugin = (
  plugin: ReturnType<typeof d1WorkerDatabase>,
): UniversalComponentDataAdapter => {
  if (plugin.componentData === undefined) {
    throw new TypeError("D1 component data adapter is missing");
  }
  return plugin.componentData;
};

const resolveAdapter = (): UniversalComponentDataAdapter =>
  resolveAdapterFromPlugin(d1WorkerDatabase(env.DB));

const componentIds = [
  legacyCompatibleCheckSchema.id,
  syntheticAuditLogSchema.id,
  syntheticAuditLogMigrationSchema.id,
  syntheticSecurityLogSchema.id,
  validationOnlyCheckSchema.id,
] as const;

const resetComponentData = async (): Promise<void> => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS private_hot_updater_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare("DROP TABLE IF EXISTS audit_records").run();
  await env.DB.prepare("DROP TABLE IF EXISTS audit_history_records").run();
  await env.DB.prepare("DROP TABLE IF EXISTS compatibility_records").run();
  await env.DB.prepare("DROP TABLE IF EXISTS security_records").run();
  await env.DB.prepare("DROP TABLE IF EXISTS validation_records").run();
  await env.DB.prepare(
    "DELETE FROM private_hot_updater_settings WHERE key = 'version'",
  ).run();
  for (const id of componentIds) {
    await env.DB.prepare(
      "DELETE FROM private_hot_updater_settings WHERE key = ?",
    )
      .bind(`schema.${id}`)
      .run();
  }
};

const artifactForVersion = (
  adapter: UniversalComponentDataAdapter,
  schema: UniversalComponentSchema,
  version: string,
): UniversalComponentArtifact => {
  const target = schema.versions.find(
    (candidate) => candidate.version === version,
  );
  if (target === undefined || adapter.artifacts === undefined) {
    throw new TypeError(`Missing D1 artifact for version ${version}`);
  }
  const artifact = adapter.artifacts({
    id: schema.id,
    versions: [target],
  })[0];
  if (artifact === undefined) {
    throw new TypeError(`Missing D1 artifact for version ${version}`);
  }
  return artifact;
};

const setHarnessSetting = async (
  key: string,
  value: unknown,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO private_hot_updater_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, typeof value === "string" ? value : JSON.stringify(value))
    .run();
};

const getHarnessSetting = async (key: string): Promise<unknown> => {
  const row = await env.DB.prepare(
    "SELECT value FROM private_hot_updater_settings WHERE key = ?",
  )
    .bind(key)
    .first<{ readonly value: string }>();
  if (row === null) return null;
  if (row.value.startsWith("{")) return JSON.parse(row.value);
  return row.value;
};

const insertMigrationRow = async (
  row: UniversalComponentRow,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO audit_history_records (
      id, recorded_at_ms, action, actor_id
    ) VALUES (?, ?, ?, ?)`,
  )
    .bind(row.id, row.recorded_at_ms, row.action, row.actor_id)
    .run();
};

const seedMigrationState = async (
  adapter: UniversalComponentDataAdapter,
  schema: UniversalComponentSchema,
  state: SyntheticUniversalComponentMigrationState,
): Promise<void> => {
  await resetComponentData();
  if (state.physicalState !== "absent") {
    const version = state.physicalState === "version-2" ? "2" : "1";
    await env.DB.exec(artifactForVersion(adapter, schema, version).contents);
    if (state.physicalState === "drift") {
      await env.DB.prepare(
        "DROP INDEX audit_history_chronological_v1_idx",
      ).run();
    }
  }
  await env.DB.prepare("DELETE FROM private_hot_updater_settings WHERE key = ?")
    .bind(`schema.${schema.id}`)
    .run();
  if (state.componentVersion !== null) {
    await setHarnessSetting(`schema.${schema.id}`, state.componentVersion);
  }
  if (state.legacyVersion !== null) {
    await setHarnessSetting("version", state.legacyVersion);
  }
  await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
  try {
    for (const row of state.rows) {
      await insertMigrationRow(row as UniversalComponentRow);
    }
  } finally {
    await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
  }
};

const inspectMigrationState = async (
  schema: UniversalComponentSchema,
): Promise<SyntheticUniversalComponentMigrationState> => {
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_history_records'",
  ).first();
  let physicalState: SyntheticUniversalComponentMigrationState["physicalState"] =
    "absent";
  let rows: readonly unknown[] = [];
  if (table !== null) {
    const indexes = await env.DB.prepare(
      "PRAGMA index_list('audit_history_records')",
    ).all<{ readonly name: string }>();
    const names = new Set(indexes.results.map(({ name }) => name));
    physicalState = names.has("audit_history_chronological_v2_idx")
      ? "version-2"
      : names.has("audit_history_chronological_v1_idx")
        ? "version-1"
        : "drift";
    const storedRows = await env.DB.prepare(
      `SELECT id, recorded_at_ms, action, actor_id
       FROM audit_history_records ORDER BY id`,
    ).all<UniversalComponentRow>();
    rows = storedRows.results;
  }
  return {
    componentVersion: await getHarnessSetting(`schema.${schema.id}`),
    legacyVersion: await getHarnessSetting("version"),
    physicalState,
    rows,
  };
};

setupUniversalComponentMigrationTestSuite({
  name: "cloudflare worker d1 universal component migration",
  createHarness: () => {
    const adapter = resolveAdapter();
    return {
      adapter,
      inspect: inspectMigrationState,
      seed: (schema, state) => seedMigrationState(adapter, schema, state),
    };
  },
});

describe("cloudflare worker d1 component migration atomicity", () => {
  beforeEach(resetComponentData);

  it("rejects an undeclared trigger without marking the component", async () => {
    const adapter = resolveAdapter();
    const initial: SyntheticUniversalComponentMigrationState = {
      componentVersion: null,
      legacyVersion: syntheticMigrationLegacyEvidence.version1,
      physicalState: "version-1",
      rows: [syntheticMigrationV1Row],
    };
    await seedMigrationState(
      adapter,
      syntheticAuditLogMigrationSchema,
      initial,
    );
    await env.DB.prepare(
      `CREATE TRIGGER unexpected_audit_history_insert
       AFTER INSERT ON audit_history_records
       BEGIN
         SELECT 1;
       END`,
    ).run();

    await expect(
      adapter.migrate?.(syntheticAuditLogMigrationSchema),
    ).rejects.toThrow(/table audit_history_records triggers/);
    await expect(
      inspectMigrationState(syntheticAuditLogMigrationSchema),
    ).resolves.toEqual(initial);
  });

  it("adopts an unquoted table with canonical plain checks", async () => {
    const adapter = resolveAdapter();
    await env.DB.prepare(
      `CREATE TABLE compatibility_records (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        previous_id TEXT,
        strategy TEXT,
        CONSTRAINT compatibility_kind_check
          CHECK (kind IN ('APPLIED', 'RECOVERED', 'UNCHANGED')),
        CONSTRAINT compatibility_strategy_check
          CHECK (strategy IS NULL OR strategy IN ('fingerprint', 'appVersion')),
        CONSTRAINT compatibility_shape_check
          CHECK (
            (kind IN ('APPLIED', 'RECOVERED')
              AND previous_id IS NOT NULL
              AND strategy IS NOT NULL)
            OR (kind = 'UNCHANGED'
              AND previous_id IS NULL
              AND strategy IS NULL)
          )
      )`,
    ).run();

    await adapter.migrate?.(legacyCompatibleCheckSchema);

    await expect(
      getHarnessSetting("schema.compatibility-history"),
    ).resolves.toBe("1");
  });

  it("rolls the physical transition back when the final marker write fails", async () => {
    const adapter = resolveAdapter();
    const initial: SyntheticUniversalComponentMigrationState = {
      componentVersion: "1",
      legacyVersion: syntheticMigrationLegacyEvidence.version1,
      physicalState: "version-1",
      rows: [syntheticMigrationV1Row],
    };
    await seedMigrationState(
      adapter,
      syntheticAuditLogMigrationSchema,
      initial,
    );
    await env.DB.prepare(
      `CREATE TRIGGER reject_audit_history_marker
       BEFORE UPDATE OF value ON private_hot_updater_settings
       WHEN NEW.key = 'schema.audit-history' AND NEW.value = '2'
       BEGIN
         SELECT RAISE(ABORT, 'forced marker failure');
       END`,
    ).run();

    await expect(
      adapter.migrate?.(syntheticAuditLogMigrationSchema),
    ).rejects.toThrow(/forced marker failure/);
    await expect(
      inspectMigrationState(syntheticAuditLogMigrationSchema),
    ).resolves.toEqual(initial);

    await env.DB.prepare("DROP TRIGGER reject_audit_history_marker").run();
    await adapter.migrate?.(syntheticAuditLogMigrationSchema);
    await expect(
      inspectMigrationState(syntheticAuditLogMigrationSchema),
    ).resolves.toEqual({
      ...initial,
      componentVersion: "2",
      physicalState: "version-2",
    });
  });
});

describe("cloudflare worker d1 component readiness validation", () => {
  beforeEach(resetComponentData);

  it("keeps validation-only checks out of storage and enforces them before adoption", async () => {
    const adapter = resolveAdapter();
    const artifact = adapter.artifacts?.(validationOnlyCheckSchema)[0];
    if (artifact === undefined) {
      throw new TypeError("Missing validation-only D1 artifact");
    }
    expect(artifact.contents).not.toContain("validation_score_non_negative");
    await env.DB.exec(artifact.contents);
    await env.DB.prepare(
      "DELETE FROM private_hot_updater_settings WHERE key = 'schema.validation-history'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO validation_records (id, score) VALUES ('invalid', -1)",
    ).run();

    await expect(adapter.migrate?.(validationOnlyCheckSchema)).rejects.toThrow(
      /Invalid row/,
    );
    await expect(
      getHarnessSetting("schema.validation-history"),
    ).resolves.toBeNull();
  });

  it("polls the marker while caching only a successful full validation", async () => {
    const adapter = resolveAdapter();
    await adapter.migrate?.(syntheticAuditLogMigrationSchema);
    await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
    try {
      await insertMigrationRow({
        action: "invalid-runtime-row",
        actor_id: "actor-corrupt",
        id: "00000000-0000-4000-8000-000000000099",
        recorded_at_ms: -1,
      });
    } finally {
      await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }

    const counts = { catalog: 0, marker: 0, rows: 0 };
    const countedDatabase = {
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      prepare(sql: string) {
        if (sql.includes("private_hot_updater_settings WHERE key")) {
          counts.marker += 1;
        } else if (sql.startsWith("PRAGMA") || sql.includes("sqlite_master")) {
          counts.catalog += 1;
        } else if (sql.includes('FROM "audit_history_records"')) {
          counts.rows += 1;
        }
        return env.DB.prepare(sql);
      },
    };
    const countedAdapter = resolveAdapterFromPlugin(
      d1WorkerDatabase(countedDatabase),
    );
    const source = countedAdapter.bind(syntheticAuditLogMigrationSchema);

    await expect(source.assertReady()).rejects.toMatchObject({
      reason: "stored-data",
    });
    await env.DB.prepare(
      "DELETE FROM audit_history_records WHERE recorded_at_ms < 0",
    ).run();
    await source.assertReady();
    const afterValidation = { ...counts };

    await source.assertReady();

    expect(counts.marker).toBe(afterValidation.marker + 1);
    expect(counts.catalog).toBe(afterValidation.catalog);
    expect(counts.rows).toBe(afterValidation.rows);
  });

  it("revalidates scanned rows after readiness has been cached", async () => {
    const adapter = resolveAdapter();
    await adapter.migrate?.(syntheticAuditLogMigrationSchema);
    const source = adapter.bind(syntheticAuditLogMigrationSchema);
    await source.assertReady();
    await insertMigrationRow(syntheticMigrationValidationOnlyCorruptRow);

    await expect(
      source.orderedScan({
        accessPattern: "chronological",
        beforePrefixExclusive: [Number.MAX_SAFE_INTEGER],
        limit: 10,
      }),
    ).rejects.toMatchObject({ reason: "stored-data" });
  });
});

const storedAuditVersion = async (): Promise<string | null> => {
  const row = await env.DB.prepare(
    `SELECT value FROM private_hot_updater_settings
     WHERE key = 'schema.audit-log'`,
  ).first<{ readonly value: string }>();
  return row?.value ?? null;
};

const migrateAuditSchema = async (
  adapter: UniversalComponentDataAdapter,
): Promise<void> => {
  if (adapter.migrate === undefined) {
    throw new TypeError("D1 component data migration is missing");
  }
  await adapter.migrate(syntheticAuditLogSchema);
};

const createAuditTable = async (columns: string): Promise<void> => {
  await env.DB.prepare(`CREATE TABLE audit_records (${columns})`).run();
  await env.DB.prepare(
    `CREATE INDEX audit_records_chronological_idx
     ON audit_records (recorded_at_ms, id)`,
  ).run();
};

setupUniversalComponentDataAdapterTestSuite({
  name: "cloudflare worker d1 universal component data adapter",
  createAdapter: resolveAdapter,
  reset: resetComponentData,
  dispose: () => undefined,
  readinessFailures: [
    {
      name: "physical schema drift",
      async prepare(adapter, schema) {
        const artifact = adapter.artifacts?.(schema)[0];
        if (artifact === undefined) throw new TypeError("Missing D1 artifact");
        await env.DB.exec(artifact.contents);
        await env.DB.prepare(
          "ALTER TABLE audit_records ADD COLUMN undeclared TEXT",
        ).run();
      },
    },
    {
      name: "declared index drift",
      async prepare(adapter, schema) {
        const artifact = adapter.artifacts?.(schema)[0];
        if (artifact === undefined) throw new TypeError("Missing D1 artifact");
        await env.DB.exec(artifact.contents);
        await env.DB.prepare(
          "DROP INDEX audit_records_chronological_idx",
        ).run();
      },
    },
    {
      name: "stored data drift",
      async prepare(adapter, schema) {
        const artifact = adapter.artifacts?.(schema)[0];
        if (artifact === undefined) throw new TypeError("Missing D1 artifact");
        await env.DB.exec(artifact.contents);
        await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
        try {
          await env.DB.prepare(
            `INSERT INTO audit_records (
              id, recorded_at_ms, action, actor_id, accepted, risk_score, payload
            ) VALUES ('corrupt', 1, 'read', NULL, 1, 0.5, '{')`,
          ).run();
        } finally {
          await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
        }
      },
    },
  ],
  async setStoredVersion(_adapter, schema, version) {
    await env.DB.prepare(
      `INSERT INTO private_hot_updater_settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(`schema.${schema.id}`, version)
      .run();
  },
});

describe("cloudflare worker d1 component schema drift", () => {
  beforeEach(resetComponentData);

  it("emits logical boolean and JSON constraints before the marker", () => {
    const artifact = resolveAdapter().artifacts?.(syntheticAuditLogSchema)[0];
    const contents = artifact?.contents;

    expect(artifact?.targetVersion).toBe("1");
    expect(artifact?.path).toContain("d1-1.sql");
    expect(contents).toContain('CHECK ("accepted" IN (0, 1))');
    expect(contents).toContain('CHECK (json_valid("payload"))');
    expect(contents?.lastIndexOf("'schema.audit-log', '1'")).toBeGreaterThan(
      contents?.lastIndexOf('CHECK ("payload"') ?? -1,
    );
  });

  it("emits logical UUID storage and named checks for the target version", () => {
    const artifact = resolveAdapter().artifacts?.(
      syntheticAuditLogMigrationSchema,
    )[0];

    expect(artifact?.targetVersion).toBe("2");
    expect(artifact?.contents).toContain(
      'CONSTRAINT "audit_history_time_v2" CHECK',
    );
    expect(artifact?.contents).toContain('"id" TEXT PRIMARY KEY NOT NULL');
    expect(artifact?.contents).not.toContain("GLOB");
    expect(
      artifact?.contents.lastIndexOf("'schema.audit-history', '2'"),
    ).toBeGreaterThan(
      artifact?.contents.lastIndexOf('CONSTRAINT "audit_history_actor_v2"') ??
        -1,
    );
  });

  it("does not mark an existing table with a missing column ready", async () => {
    await createAuditTable(`
      id TEXT PRIMARY KEY NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      risk_score REAL NOT NULL
    `);

    const adapter = resolveAdapter();

    await expect(migrateAuditSchema(adapter)).rejects.toThrow(
      /incompatible D1 schema/,
    );
    await expect(storedAuditVersion()).resolves.toBeNull();
  });

  it("does not mark an existing table with wrong nullability ready", async () => {
    await createAuditTable(`
      id TEXT PRIMARY KEY NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      action TEXT,
      actor_id TEXT,
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      risk_score REAL NOT NULL,
      payload TEXT NOT NULL
    `);

    const adapter = resolveAdapter();

    await expect(migrateAuditSchema(adapter)).rejects.toThrow(
      /incompatible D1 schema/,
    );
    await expect(storedAuditVersion()).resolves.toBeNull();
  });

  it("does not adopt a table without the declared boolean constraint", async () => {
    await createAuditTable(`
      "id" TEXT PRIMARY KEY NOT NULL,
      "recorded_at_ms" INTEGER NOT NULL,
      "action" TEXT NOT NULL,
      "actor_id" TEXT,
      "accepted" INTEGER NOT NULL,
      "risk_score" REAL NOT NULL,
      "payload" TEXT NOT NULL
        CHECK ("payload" IS NULL OR json_valid("payload"))
    `);

    const adapter = resolveAdapter();

    await expect(migrateAuditSchema(adapter)).rejects.toThrow(
      /table audit_records constraints/,
    );
    await expect(storedAuditVersion()).resolves.toBeNull();
  });

  it("does not adopt a JSON column without validation", async () => {
    await createAuditTable(`
      "id" TEXT PRIMARY KEY NOT NULL,
      "recorded_at_ms" INTEGER NOT NULL,
      "action" TEXT NOT NULL,
      "actor_id" TEXT,
      "accepted" INTEGER NOT NULL CHECK ("accepted" IN (0, 1)),
      "risk_score" REAL NOT NULL,
      "payload" TEXT NOT NULL
    `);

    const adapter = resolveAdapter();

    await expect(migrateAuditSchema(adapter)).rejects.toThrow(
      /table audit_records constraints/,
    );
    await expect(storedAuditVersion()).resolves.toBeNull();
  });

  it("fails readiness when a declared index disappears", async () => {
    const adapter = resolveAdapter();
    await migrateAuditSchema(adapter);
    await env.DB.prepare("DROP INDEX audit_records_chronological_idx").run();

    await expect(
      resolveAdapter().bind(syntheticAuditLogSchema).assertReady(),
    ).rejects.toMatchObject({
      name: "UniversalComponentDataStateNotReadyError",
      reason: "index",
    });
    await expect(storedAuditVersion()).resolves.toBe("1");
  });

  it("rejects malformed values returned from declared columns", async () => {
    const adapter = resolveAdapter();
    await migrateAuditSchema(adapter);
    await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
    try {
      await env.DB.prepare(
        `INSERT INTO audit_records (
          id, recorded_at_ms, action, actor_id, accepted, risk_score, payload
        ) VALUES ('corrupt', 1, 'read', NULL, 1, 0.5, '{')`,
      ).run();
    } finally {
      await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }

    await expect(
      adapter.bind(syntheticAuditLogSchema).orderedScan({
        accessPattern: "chronological",
        beforePrefixExclusive: [2],
        limit: 10,
      }),
    ).rejects.toMatchObject({
      name: "UniversalComponentDataStateNotReadyError",
      reason: "stored-data",
    });
  });
});
