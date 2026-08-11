import { PGlite } from "@electric-sql/pglite";
import type {
  UniversalComponentDataAdapter,
  UniversalComponentRow,
  UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import {
  defineUniversalComponentSchema,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";
import {
  syntheticAuditLogMigrationSchema,
  syntheticMigrationLegacyEvidence,
  syntheticMigrationV1Row,
} from "@hot-updater/test-utils";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";
import { SupabaseDatabaseError } from "./supabaseResult";
import { createSupabaseUniversalComponentDataAdapter } from "./supabaseUniversalComponentData";
import type { Database } from "./types";

const auditLogSchema: UniversalComponentSchema = defineUniversalComponentSchema(
  {
    id: "audit-log",
    versions: [
      {
        version: "7",
        tables: [
          {
            name: "audit_records",
            columns: [
              { name: "id", type: "string", primaryKey: true },
              { name: "occurred_at", type: "string" },
              { name: "sequence", type: "integer" },
              { name: "payload", type: "json" },
              { name: "actor", type: "string", nullable: true },
            ],
            indexes: [
              {
                name: "audit_records_timeline_idx",
                columns: ["occurred_at", "id"],
              },
            ],
          },
        ],
        orderedScans: [
          {
            name: "timeline",
            table: "audit_records",
            columns: ["occurred_at", "id"],
          },
        ],
      },
    ],
  },
);

const strictHistorySchema = defineUniversalComponentSchema({
  id: "strict-history",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "strict_history_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "score", type: "integer" },
            { name: "category", type: "string", nullable: true },
          ],
          checks: [
            {
              name: "strict_history_score_v1",
              expression: { column: "score", op: "gte", value: 0 },
            },
          ],
          indexes: [
            {
              name: "strict_history_score_v1_idx",
              columns: ["score", "id"],
            },
          ],
        },
      ],
    },
    {
      version: "2",
      tables: [
        {
          name: "strict_history_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "score", type: "integer" },
            { name: "category", type: "string" },
          ],
          checks: [
            {
              name: "strict_history_score_v2",
              expression: { column: "score", op: "gte", value: 10 },
            },
            {
              name: "strict_history_score_upper_validation",
              enforcement: "validation",
              expression: { column: "score", op: "lte", value: 20 },
            },
          ],
          indexes: [
            {
              name: "strict_history_score_v2_idx",
              columns: ["score", "id"],
              unique: true,
            },
          ],
        },
      ],
    },
  ],
});

const scanOnlyHistorySchema = defineUniversalComponentSchema({
  id: "scan-only-history",
  unmarked: {
    adopt: [{ version: "2", when: [null] }],
    createWhen: [null],
    discriminatorKey: "version",
    knownValues: [null],
  },
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "scan_only_history_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "recorded_at_ms", type: "integer" },
          ],
        },
      ],
    },
    {
      version: "2",
      tables: [
        {
          name: "scan_only_history_records",
          columns: [
            { name: "id", type: "string", primaryKey: true },
            { name: "recorded_at_ms", type: "integer" },
          ],
        },
      ],
      orderedScans: [
        {
          name: "chronological",
          table: "scan_only_history_records",
          columns: ["recorded_at_ms", "id"],
        },
      ],
    },
  ],
});

const artifactFor = (schema: UniversalComponentSchema): string => {
  const { client } = createComponentClient();
  const artifact =
    createSupabaseUniversalComponentDataAdapter(client).artifacts?.(schema)[0];
  if (artifact === undefined) {
    throw new TypeError("Supabase component artifact is unavailable");
  }
  return artifact.contents;
};

const createPostgres = async (): Promise<PGlite> => {
  const database = new PGlite();
  await database.exec(`
    CREATE ROLE anon NOLOGIN NOINHERIT;
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  `);
  return database;
};

const executeFailedArtifact = async (
  database: PGlite,
  contents: string,
): Promise<unknown> => {
  let failure: unknown;
  try {
    await database.exec(contents);
  } catch (error) {
    failure = error;
    await database.exec("ROLLBACK;");
  }
  expect(failure).toBeDefined();
  return failure;
};

const seedAuditHistoryV1 = async (
  database: PGlite,
  options: {
    readonly componentMarker?: boolean;
    readonly discriminator?: string;
  } = {},
): Promise<void> => {
  await database.exec(`
    CREATE TABLE public.private_hot_updater_settings (
      key text NOT NULL,
      value text NOT NULL,
      CONSTRAINT private_hot_updater_settings_pkey PRIMARY KEY (key)
    );
    INSERT INTO public.private_hot_updater_settings (key, value)
    VALUES ('version', '${options.discriminator ?? syntheticMigrationLegacyEvidence.version1}');
    ${
      options.componentMarker === false
        ? ""
        : `INSERT INTO public.private_hot_updater_settings (key, value)
           VALUES ('schema.audit-history', '1');`
    }
    CREATE TABLE public.audit_history_records (
      id uuid NOT NULL,
      recorded_at_ms bigint NOT NULL,
      action text NOT NULL,
      actor_id text NOT NULL,
      CONSTRAINT audit_history_records_pkey PRIMARY KEY (id),
      CONSTRAINT audit_history_action_non_empty
        CHECK (action <> ''),
      CONSTRAINT audit_history_time_v1 CHECK (
        recorded_at_ms = trunc(recorded_at_ms)
        AND recorded_at_ms >= 0
      ),
      CONSTRAINT audit_history_actor_v1
        CHECK (actor_id <> '')
    );
    CREATE INDEX audit_history_chronological_v1_idx
      ON public.audit_history_records (recorded_at_ms, id);
    INSERT INTO public.audit_history_records (
      id, recorded_at_ms, action, actor_id
    ) VALUES (
      '${syntheticMigrationV1Row.id}',
      ${syntheticMigrationV1Row.recorded_at_ms},
      '${syntheticMigrationV1Row.action}',
      '${syntheticMigrationV1Row.actor_id}'
    );
  `);
};

const seedStrictHistoryV1 = async (database: PGlite): Promise<void> => {
  await database.exec(`
    CREATE TABLE public.private_hot_updater_settings (
      key text NOT NULL,
      value text NOT NULL,
      CONSTRAINT private_hot_updater_settings_pkey PRIMARY KEY (key)
    );
    INSERT INTO public.private_hot_updater_settings (key, value)
    VALUES ('schema.strict-history', '1');
    CREATE TABLE public.strict_history_records (
      id text NOT NULL,
      score bigint NOT NULL,
      category text,
      CONSTRAINT strict_history_records_pkey PRIMARY KEY (id),
      CONSTRAINT strict_history_score_v1
        CHECK (score >= 0)
    );
    CREATE INDEX strict_history_score_v1_idx
      ON public.strict_history_records (score, id);
    INSERT INTO public.strict_history_records (id, score, category)
    SELECT
      'record-' || value::text,
      CASE WHEN value = 1025 THEN 50 ELSE 10 END,
      'stable'
    FROM generate_series(1, 1025) AS value;
  `);
};

interface QueryTrace {
  columns?: string;
  equals: readonly { readonly column: string; readonly value: unknown }[];
  filter?: string;
  limit?: number;
  orders: readonly string[];
  range?: readonly [number, number];
  table: string;
}

interface ComponentQueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

const createComponentClient = (options?: {
  readonly errors?: Readonly<Record<string, PostgrestError>>;
  readonly marker?: string | null;
  readonly scanRows?: readonly Record<string, unknown>[];
}) => {
  const inserted: UniversalComponentRow[] = [];
  const traces: QueryTrace[] = [];
  const marker = options?.marker === undefined ? "7" : options.marker;
  const scanRows = options?.scanRows ?? [];

  class Query {
    private columns: string | undefined;
    private readonly equals: { column: string; value: unknown }[] = [];
    private filter: string | undefined;
    private insertedRow: UniversalComponentRow | undefined;
    private limitValue: number | undefined;
    private readonly orders: string[] = [];
    private rangeValue: readonly [number, number] | undefined;

    constructor(private readonly table: string) {}

    select(columns: string) {
      this.columns = columns;
      return this;
    }
    eq(column: string, value: unknown) {
      this.equals.push({ column, value });
      return this;
    }
    insert(row: UniversalComponentRow) {
      this.insertedRow = row;
      return this;
    }
    or(filter: string) {
      this.filter = filter;
      return this;
    }
    order(column: string, _options: { readonly ascending: boolean }) {
      this.orders.push(column);
      return this;
    }
    limit(value: number) {
      this.limitValue = value;
      return this;
    }
    maybeSingle() {
      return this;
    }
    range(from: number, to: number) {
      this.rangeValue = [from, to];
      return this;
    }
    then<TResult1 = ComponentQueryResult, TResult2 = never>(
      onfulfilled?:
        | ((value: ComponentQueryResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ) {
      return this.execute().then(onfulfilled, onrejected);
    }

    private async execute(): Promise<ComponentQueryResult> {
      traces.push({
        table: this.table,
        ...(this.columns === undefined ? {} : { columns: this.columns }),
        equals: [...this.equals],
        ...(this.filter === undefined ? {} : { filter: this.filter }),
        ...(this.limitValue === undefined ? {} : { limit: this.limitValue }),
        orders: [...this.orders],
        ...(this.rangeValue === undefined ? {} : { range: this.rangeValue }),
      });
      const error = options?.errors?.[this.table];
      if (error !== undefined) return { data: null, error };
      if (this.insertedRow !== undefined) {
        inserted.push(this.insertedRow);
        return { data: null, error: null };
      }
      if (this.table === "private_hot_updater_settings") {
        return {
          data: marker === null ? null : { value: marker },
          error: null,
        };
      }
      const rows =
        this.rangeValue === undefined
          ? scanRows.slice(0, this.limitValue)
          : scanRows.slice(this.rangeValue[0], this.rangeValue[1] + 1);
      return {
        data: rows,
        error: null,
      };
    }
  }

  return {
    client: {
      from: (table: string) => new Query(table),
    } as unknown as SupabaseClient<Database>,
    inserted,
    traces,
  };
};

describe("Supabase universal component data adapter", () => {
  it("exposes a provider-neutral component data adapter", () => {
    const database = supabaseDatabase({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseServiceRoleKey: "test-service-role-key",
    });

    expect(database.componentData).toBeDefined();
  });

  it("generates a version-tagged transactional migration artifact", () => {
    const { client } = createComponentClient();
    const adapter = createSupabaseUniversalComponentDataAdapter(client);

    expect(adapter.migrate).toBeUndefined();
    expect(adapter.artifacts?.(auditLogSchema)).toEqual([
      {
        path: "component-data/audit-log/supabase-7.sql",
        targetVersion: "7",
        contents: expect.stringContaining('-- target-version: "7"'),
      },
    ]);
    const contents = artifactFor(syntheticAuditLogMigrationSchema);
    expect(contents.startsWith("-- HotUpdater.component-data\n")).toBe(true);
    expect(contents).toContain("BEGIN;");
    expect(contents).toContain("COMMIT;");
    expect(contents).toContain('"id" uuid NOT NULL');
    expect(contents).toContain(
      'DROP INDEX "public"."audit_history_chronological_v1_idx"',
    );
    expect(contents).toContain('ALTER COLUMN "actor_id" DROP NOT NULL');
    const strictContents = artifactFor(strictHistorySchema);
    expect(strictContents).toContain('ALTER COLUMN "category" SET NOT NULL');
    expect(strictContents).not.toContain(
      'CONSTRAINT "strict_history_score_upper_validation"',
    );
    expect(strictContents).toContain('NOT COALESCE((("score" <= 20)), FALSE)');
    expect(contents).toContain('ADD CONSTRAINT "audit_history_actor_v2" CHECK');
    expect(contents).toContain(
      '(("actor_id" IS NULL) OR ("actor_id" <> \'\'))',
    );
    expect(contents).not.toContain('"actor_id" IS NOT NULL AND');
    expect(contents).toContain("NOT VALID");
    expect(contents).toContain('VALIDATE CONSTRAINT "audit_history_actor_v2"');
    expect(contents).toContain("pg_catalog.pg_get_constraintdef");
    expect(contents).toContain("pg_catalog.pg_attribute");
    expect(contents).toContain(
      'ALTER TABLE "public"."audit_history_records" ENABLE ROW LEVEL SECURITY',
    );
    expect(contents).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "public"."audit_history_records" FROM PUBLIC, anon, authenticated',
    );
    expect(contents).toContain(
      'ALTER TABLE "public"."private_hot_updater_settings" ENABLE ROW LEVEL SECURITY',
    );
    expect(contents).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "public"."private_hot_updater_settings" FROM PUBLIC, anon, authenticated',
    );
    expect(contents).toContain("'schema.audit-history', '2'");
    expect(contents.lastIndexOf("'schema.audit-history', '2'")).toBeGreaterThan(
      contents.lastIndexOf("REVOKE ALL PRIVILEGES"),
    );
  });

  it("creates and reruns an exact secured schema on PostgreSQL", async () => {
    const database = await createPostgres();
    try {
      const contents = artifactFor(syntheticAuditLogMigrationSchema);
      await database.exec(contents);
      await database.exec(contents);

      const marker = await database.query<{ value: string }>(`
        SELECT value FROM public.private_hot_updater_settings
        WHERE key = 'schema.audit-history'
      `);
      const security = await database.query<{
        authenticated_select: boolean;
        events_rls: boolean;
        settings_rls: boolean;
      }>(`
        SELECT
          has_table_privilege(
            'authenticated',
            'public.audit_history_records',
            'SELECT'
          ) AS authenticated_select,
          (
            SELECT relrowsecurity FROM pg_class
            WHERE oid = 'public.audit_history_records'::regclass
          ) AS events_rls,
          (
            SELECT relrowsecurity FROM pg_class
            WHERE oid = 'public.private_hot_updater_settings'::regclass
          ) AS settings_rls
      `);

      expect(marker.rows).toEqual([{ value: "2" }]);
      expect(security.rows).toEqual([
        {
          authenticated_select: false,
          events_rls: true,
          settings_rls: true,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("chooses the newest version when physical snapshots are identical", async () => {
    const database = await createPostgres();
    try {
      await database.exec(`
        CREATE TABLE public.private_hot_updater_settings (
          key text NOT NULL,
          value text NOT NULL,
          CONSTRAINT private_hot_updater_settings_pkey PRIMARY KEY (key)
        );
        CREATE TABLE public.scan_only_history_records (
          id text NOT NULL,
          recorded_at_ms bigint NOT NULL,
          CONSTRAINT scan_only_history_records_pkey PRIMARY KEY (id)
        );
        INSERT INTO public.scan_only_history_records (id, recorded_at_ms)
        VALUES ('preserved', 1);
      `);

      await database.exec(artifactFor(scanOnlyHistorySchema));

      const state = await database.query<{ count: number; marker: string }>(`
        SELECT
          (SELECT count(*)::integer FROM scan_only_history_records) AS count,
          (
            SELECT value FROM private_hot_updater_settings
            WHERE key = 'schema.scan-only-history'
          ) AS marker
      `);
      expect(state.rows).toEqual([{ count: 1, marker: "2" }]);
    } finally {
      await database.close();
    }
  });

  it("adopts old-style plain named checks and preserves UUID rows", async () => {
    const database = await createPostgres();
    try {
      await seedAuditHistoryV1(database, { componentMarker: false });
      await database.exec(`
        GRANT SELECT ON public.audit_history_records TO anon, authenticated;
      `);

      const contents = artifactFor(syntheticAuditLogMigrationSchema);
      await database.exec(contents);
      await database.exec(contents);

      const rows = await database.query<{
        action: string;
        actor_id: string | null;
        id: string;
        recorded_at_ms: bigint;
      }>(`
        SELECT id, recorded_at_ms, action, actor_id
        FROM public.audit_history_records
      `);
      const state = await database.query<{
        actor_nullable: string;
        authenticated_select: boolean;
        marker: string;
      }>(`
        SELECT
          (
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'audit_history_records'
              AND column_name = 'actor_id'
          ) AS actor_nullable,
          has_table_privilege(
            'authenticated',
            'public.audit_history_records',
            'SELECT'
          ) AS authenticated_select,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.audit-history'
          ) AS marker
      `);

      expect(rows.rows).toEqual([syntheticMigrationV1Row]);
      expect(state.rows).toEqual([
        {
          actor_nullable: "YES",
          authenticated_select: false,
          marker: "2",
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects unmarked v1 state when its discriminator only permits v2", async () => {
    const database = await createPostgres();
    try {
      await seedAuditHistoryV1(database, {
        componentMarker: false,
        discriminator: syntheticMigrationLegacyEvidence.version2,
      });

      const failure = await executeFailedArtifact(
        database,
        artifactFor(syntheticAuditLogMigrationSchema),
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "migration state is incompatible",
      );

      const state = await database.query<{
        actor_nullable: string;
        count: number;
        marker: string | null;
      }>(`
        SELECT
          (
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'audit_history_records'
              AND column_name = 'actor_id'
          ) AS actor_nullable,
          (SELECT count(*)::integer FROM audit_history_records) AS count,
          (
            SELECT value FROM private_hot_updater_settings
            WHERE key = 'schema.audit-history'
          ) AS marker
      `);
      expect(state.rows).toEqual([
        { actor_nullable: "NO", count: 1, marker: null },
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects a marker/shape contradiction without touching stored rows", async () => {
    const database = await createPostgres();
    try {
      await seedAuditHistoryV1(database);
      await database.exec(`
        UPDATE public.private_hot_updater_settings
        SET value = '2'
        WHERE key = 'schema.audit-history';
      `);

      const failure = await executeFailedArtifact(
        database,
        artifactFor(syntheticAuditLogMigrationSchema),
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "migration state is incompatible",
      );

      const marker = await database.query<{ value: string }>(`
        SELECT value FROM public.private_hot_updater_settings
        WHERE key = 'schema.audit-history'
      `);
      const count = await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM public.audit_history_records
      `);
      expect(marker.rows).toEqual([{ value: "2" }]);
      expect(count.rows).toEqual([{ count: 1 }]);
    } finally {
      await database.close();
    }
  });

  it("repairs a lagging marker when the physical schema is already latest", async () => {
    const database = await createPostgres();
    try {
      const contents = artifactFor(syntheticAuditLogMigrationSchema);
      await database.exec(contents);
      await database.exec(`
        INSERT INTO public.audit_history_records (
          id, recorded_at_ms, action, actor_id
        ) VALUES (
          '00000000-0000-4000-8000-000000000099',
          99,
          'anonymous-read',
          NULL
        );
        UPDATE public.private_hot_updater_settings
        SET value = '1'
        WHERE key = 'schema.audit-history';
      `);

      await database.exec(contents);

      const state = await database.query<{ count: number; marker: string }>(`
        SELECT
          (SELECT count(*)::integer FROM audit_history_records) AS count,
          (
            SELECT value FROM private_hot_updater_settings
            WHERE key = 'schema.audit-history'
          ) AS marker
      `);
      expect(state.rows).toEqual([{ count: 1, marker: "2" }]);
    } finally {
      await database.close();
    }
  });

  it("preflights validation-only checks and rolls back a failed marker-last write", async () => {
    const database = await createPostgres();
    try {
      await seedStrictHistoryV1(database);
      const contents = artifactFor(strictHistorySchema);

      const validationFailure = await executeFailedArtifact(database, contents);
      expect(validationFailure).toBeInstanceOf(Error);
      expect((validationFailure as Error).message).toContain(
        "contains invalid rows",
      );
      const failedValidation = await database.query<{
        count: number;
        marker: string;
        v1_check: boolean;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM public.strict_history_records) AS count,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.strict-history'
          ) AS marker,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.strict_history_records'::regclass
              AND conname = 'strict_history_score_v1'
          ) AS v1_check
      `);
      expect(failedValidation.rows).toEqual([
        { count: 1025, marker: "1", v1_check: true },
      ]);

      await database.exec(`
        UPDATE public.strict_history_records SET score = 10 WHERE score = 50;
        CREATE FUNCTION reject_strict_history_marker()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.key = 'schema.strict-history' AND NEW.value = '2' THEN
            RAISE EXCEPTION 'synthetic marker interruption';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_strict_history_marker
        BEFORE INSERT OR UPDATE ON public.private_hot_updater_settings
        FOR EACH ROW EXECUTE FUNCTION reject_strict_history_marker();
      `);
      const interruption = await executeFailedArtifact(database, contents);
      expect(interruption).toBeInstanceOf(Error);
      expect((interruption as Error).message).toContain(
        "synthetic marker interruption",
      );

      const interrupted = await database.query<{
        marker: string;
        v1_check: boolean;
        v1_index: boolean;
      }>(`
        SELECT
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.strict-history'
          ) AS marker,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.strict_history_records'::regclass
              AND conname = 'strict_history_score_v1'
          ) AS v1_check,
          to_regclass('public.strict_history_score_v1_idx') IS NOT NULL
            AS v1_index
      `);
      expect(interrupted.rows).toEqual([
        { marker: "1", v1_check: true, v1_index: true },
      ]);

      await database.exec(`
        DROP TRIGGER reject_strict_history_marker
          ON public.private_hot_updater_settings;
        DROP FUNCTION reject_strict_history_marker();
      `);
      await database.exec(contents);
      await database.exec(contents);

      const completed = await database.query<{
        category_nullable: string;
        count: number;
        marker: string;
        validation_check: boolean;
        v2_check: boolean;
        v2_index: boolean;
      }>(`
        SELECT
          (
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'strict_history_records'
              AND column_name = 'category'
          ) AS category_nullable,
          (SELECT count(*)::integer FROM public.strict_history_records) AS count,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.strict-history'
          ) AS marker,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.strict_history_records'::regclass
              AND conname = 'strict_history_score_upper_validation'
          ) AS validation_check,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.strict_history_records'::regclass
              AND conname = 'strict_history_score_v2'
              AND convalidated
          ) AS v2_check,
          to_regclass('public.strict_history_score_v2_idx') IS NOT NULL
            AS v2_index
      `);
      expect(completed.rows).toEqual([
        {
          category_nullable: "NO",
          count: 1025,
          marker: "2",
          validation_check: false,
          v2_check: true,
          v2_index: true,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("appends and scans with exclusive lexicographic cursors", async () => {
    const { client, inserted, traces } = createComponentClient({
      scanRows: [
        {
          actor: null,
          extra: "not declared",
          id: "b",
          occurred_at: "2026-08-11T11:00:00.000Z",
          payload: ["opened", 3],
          sequence: "3",
        },
        {
          actor: "later",
          id: "c",
          occurred_at: "2026-08-11T12:00:00.000Z",
          payload: { action: "closed" },
          sequence: 4,
        },
      ],
    });
    const source =
      createSupabaseUniversalComponentDataAdapter(client).bind(auditLogSchema);
    const row = {
      actor: "operator",
      id: "a",
      occurred_at: "2026-08-11T10:00:00.000Z",
      payload: { action: "opened" },
      sequence: 2,
    } as const;

    await source.append({ table: "audit_records", row });
    const result = await source.orderedScan({
      accessPattern: "timeline",
      afterExclusive: ["2026-08-11T10:00:00.000Z", "a"],
      beforePrefixExclusive: ["2026-08-12T00:00:00.000Z"],
      limit: 1,
    });

    expect(inserted).toEqual([row]);
    expect(result).toEqual([
      {
        actor: null,
        id: "b",
        occurred_at: "2026-08-11T11:00:00.000Z",
        payload: ["opened", 3],
        sequence: 3,
      },
    ]);
    expect(traces.at(-1)).toEqual({
      table: "audit_records",
      columns: "id,occurred_at,sequence,payload,actor",
      equals: [],
      filter:
        'and(or(occurred_at.gt."2026-08-11T10:00:00.000Z",and(occurred_at.eq."2026-08-11T10:00:00.000Z",id.gt."a")),or(occurred_at.lt."2026-08-12T00:00:00.000Z"))',
      limit: 1,
      orders: ["occurred_at", "id"],
    });
  });

  it("checks the marker every time but caches only a successful table probe", async () => {
    const { client, traces } = createComponentClient();
    const source =
      createSupabaseUniversalComponentDataAdapter(client).bind(auditLogSchema);

    await source.assertReady();
    await source.assertReady();

    expect(
      traces.filter(({ table }) => table === "private_hot_updater_settings"),
    ).toHaveLength(2);
    expect(
      traces.filter(({ table }) => table === "audit_records"),
    ).toHaveLength(1);
  });

  it("centrally validates every parsed scan row", async () => {
    const { client } = createComponentClient({
      marker: "2",
      scanRows: [
        {
          action: "not-declared-by-the-component",
          actor_id: null,
          id: "00000000-0000-4000-8000-000000000088",
          recorded_at_ms: 1,
        },
      ],
    });
    const source = createSupabaseUniversalComponentDataAdapter(client).bind(
      syntheticAuditLogMigrationSchema,
    );

    await expect(
      source.orderedScan({
        accessPattern: "chronological",
        beforePrefixExclusive: [2],
        limit: 10,
      }),
    ).rejects.toMatchObject({ reason: "stored-data" });
  });

  it("classifies latest-marker physical drift across every source operation", async () => {
    const missingTable: PostgrestError = {
      code: "42P01",
      details: "relation audit_records does not exist",
      hint: "",
      message: 'relation "audit_records" does not exist',
      name: "PostgrestError",
    };
    const operations = [
      (source: ReturnType<UniversalComponentDataAdapter["bind"]>) =>
        source.assertReady(),
      (source: ReturnType<UniversalComponentDataAdapter["bind"]>) =>
        source.append({
          table: "audit_records",
          row: {
            actor: null,
            id: "a",
            occurred_at: "2026-08-11T10:00:00.000Z",
            payload: {},
            sequence: 1,
          },
        }),
      (source: ReturnType<UniversalComponentDataAdapter["bind"]>) =>
        source.orderedScan({
          accessPattern: "timeline",
          beforePrefixExclusive: ["2026-08-12T00:00:00.000Z"],
          limit: 10,
        }),
    ];

    for (const operation of operations) {
      const { client } = createComponentClient({
        errors: { audit_records: missingTable },
      });
      const source =
        createSupabaseUniversalComponentDataAdapter(client).bind(
          auditLogSchema,
        );
      await expect(operation(source)).rejects.toBeInstanceOf(
        UniversalComponentDataStateNotReadyError,
      );
      await expect(operation(source)).rejects.toMatchObject({
        componentId: "audit-log",
        expectedVersion: "7",
        reason: "physical-schema",
      });
    }
  });

  it("classifies stored corruption beyond the first readiness page", async () => {
    const scanRows = Array.from({ length: 1_001 }, (_, index) => ({
      actor: index === 1_000 ? 42 : null,
      id: `record-${String(index).padStart(4, "0")}`,
      occurred_at: "2026-08-11T10:00:00.000Z",
      payload: {},
      sequence: index,
    }));
    const { client, traces } = createComponentClient({ scanRows });
    const source =
      createSupabaseUniversalComponentDataAdapter(client).bind(auditLogSchema);

    await expect(source.assertReady()).rejects.toMatchObject({
      componentId: "audit-log",
      expectedVersion: "7",
      reason: "stored-data",
    });
    expect(
      traces.filter(({ table }) => table === "audit_records").at(-1)?.range,
    ).toEqual([1_000, 1_999]);
  });

  it("preserves operational Supabase failures", async () => {
    const timeout: PostgrestError = {
      code: "57014",
      details: "statement timeout",
      hint: "",
      message: "canceling statement due to statement timeout",
      name: "PostgrestError",
    };
    const { client } = createComponentClient({
      errors: { audit_records: timeout },
    });
    const source =
      createSupabaseUniversalComponentDataAdapter(client).bind(auditLogSchema);

    await expect(source.assertReady()).rejects.toBeInstanceOf(
      SupabaseDatabaseError,
    );
  });

  it("rejects access while the declared schema marker is stale", async () => {
    const { client, inserted } = createComponentClient({ marker: "6" });
    const source =
      createSupabaseUniversalComponentDataAdapter(client).bind(auditLogSchema);

    await expect(
      source.append({
        table: "audit_records",
        row: {
          actor: null,
          id: "a",
          occurred_at: "2026-08-11T10:00:00.000Z",
          payload: {},
          sequence: 1,
        },
      }),
    ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);
    expect(inserted).toEqual([]);
  });
});
