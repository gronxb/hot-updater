import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// nx-ignore-next-line
import { createSupabaseUniversalComponentDataAdapter } from "../../../plugins/supabase/src/supabaseUniversalComponentData";
import { analyticsComponentSchema } from "./componentSchema";

const analyticsArtifact = () => {
  const artifact = createSupabaseUniversalComponentDataAdapter(
    undefined as never,
  ).artifacts?.(analyticsComponentSchema)[0];
  if (artifact === undefined) {
    throw new TypeError("Supabase Analytics component artifact is unavailable");
  }
  return artifact;
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

const seedAnalyticsV1 = async (
  database: PGlite,
  options: {
    readonly corruptLastRow?: boolean;
    readonly rowCount?: number;
  } = {},
): Promise<void> => {
  const rowCount = options.rowCount ?? 1;
  await database.exec(`
    CREATE TABLE public.private_hot_updater_settings (
      key text NOT NULL,
      value text NOT NULL,
      CONSTRAINT private_hot_updater_settings_pkey PRIMARY KEY (key)
    );
    INSERT INTO public.private_hot_updater_settings (key, value)
    VALUES
      ('version', '0.37.0'),
      ('schema.analytics', '1');

    CREATE TABLE public.bundle_events (
      id uuid NOT NULL,
      type text NOT NULL,
      install_id text NOT NULL,
      user_id text,
      username text,
      from_bundle_id uuid NOT NULL,
      to_bundle_id uuid NOT NULL,
      platform text NOT NULL,
      app_version text NOT NULL,
      channel text NOT NULL,
      cohort text NOT NULL,
      update_strategy text NOT NULL,
      fingerprint_hash text,
      sdk_version text,
      received_at_ms double precision NOT NULL,
      CONSTRAINT bundle_events_pkey PRIMARY KEY (id),
      CONSTRAINT bundle_events_type_check
        CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED')),
      CONSTRAINT bundle_events_update_strategy_check
        CHECK (update_strategy IN ('fingerprint', 'appVersion'))
    );
    CREATE INDEX bundle_events_installed_bundle_idx
      ON public.bundle_events (type, to_bundle_id, received_at_ms, id);
    CREATE INDEX bundle_events_recovered_bundle_idx
      ON public.bundle_events (type, from_bundle_id, received_at_ms, id);
    CREATE INDEX bundle_events_install_idx
      ON public.bundle_events (install_id, received_at_ms, id);
    CREATE INDEX bundle_events_user_id_idx
      ON public.bundle_events (user_id, received_at_ms, id);
    CREATE INDEX bundle_events_username_idx
      ON public.bundle_events (username, received_at_ms, id);
    CREATE INDEX bundle_events_cohort_idx
      ON public.bundle_events (cohort, type, received_at_ms, id);
    CREATE INDEX bundle_events_received_at_idx
      ON public.bundle_events (received_at_ms, id);

    INSERT INTO public.bundle_events (
      id,
      type,
      install_id,
      user_id,
      username,
      from_bundle_id,
      to_bundle_id,
      platform,
      app_version,
      channel,
      cohort,
      update_strategy,
      fingerprint_hash,
      sdk_version,
      received_at_ms
    )
    SELECT
      ('00000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
      'UPDATE_APPLIED',
      'install-' || value::text,
      NULL,
      NULL,
      '00000000-0000-4000-8000-100000000001'::uuid,
      '00000000-0000-4000-8000-200000000001'::uuid,
      ${
        options.corruptLastRow
          ? `CASE WHEN value = ${rowCount} THEN 'web' ELSE 'ios' END`
          : "'ios'"
      },
      '1.0.0',
      'production',
      'default',
      'fingerprint',
      NULL,
      NULL,
      value::double precision
    FROM generate_series(1, ${rowCount}) AS value;
  `);
};

describe("Analytics Supabase component artifact", () => {
  it("targets v2 and creates an idempotent secured schema", async () => {
    const database = await createPostgres();
    try {
      const artifact = analyticsArtifact();

      expect(artifact.path).toBe("component-data/analytics/supabase-2.sql");
      expect(artifact.targetVersion).toBe("2");
      expect(artifact.contents).toContain("-- component: analytics");
      expect(artifact.contents).toContain('-- target-version: "2"');
      expect(artifact.contents).toContain(
        'ALTER TABLE "public"."bundle_events" ALTER COLUMN "from_bundle_id" DROP NOT NULL',
      );
      expect(artifact.contents).toContain(
        'CONSTRAINT "bundle_events_shape_v038_check"',
      );
      expect(artifact.contents).toContain(
        'ALTER TABLE "public"."bundle_events" ENABLE ROW LEVEL SECURITY',
      );
      expect(artifact.contents).toContain(
        'REVOKE ALL PRIVILEGES ON TABLE "public"."bundle_events" FROM PUBLIC, anon, authenticated',
      );
      expect(
        artifact.contents.lastIndexOf("'schema.analytics', '2'"),
      ).toBeGreaterThan(artifact.contents.lastIndexOf("REVOKE ALL PRIVILEGES"));

      await database.exec(artifact.contents);
      await database.exec(artifact.contents);

      const state = await database.query<{
        authenticated_select: boolean;
        index_count: number;
        marker: string;
        settings_rls: boolean;
        table_rls: boolean;
      }>(`
        SELECT
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.analytics'
          ) AS marker,
          (
            SELECT count(*)::integer FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'bundle_events'
              AND indexname <> 'bundle_events_pkey'
          ) AS index_count,
          has_table_privilege(
            'authenticated',
            'public.bundle_events',
            'SELECT'
          ) AS authenticated_select,
          (
            SELECT relrowsecurity FROM pg_class
            WHERE oid = 'public.bundle_events'::regclass
          ) AS table_rls,
          (
            SELECT relrowsecurity FROM pg_class
            WHERE oid = 'public.private_hot_updater_settings'::regclass
          ) AS settings_rls
      `);

      expect(state.rows).toEqual([
        {
          authenticated_select: false,
          index_count: 7,
          marker: "2",
          settings_rls: true,
          table_rls: true,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("migrates v1 to v2 without losing stored events", async () => {
    const database = await createPostgres();
    try {
      await seedAnalyticsV1(database);
      const contents = analyticsArtifact().contents;

      await database.exec(contents);
      await database.exec(contents);

      const events = await database.query<{
        from_bundle_id: string | null;
        id: string;
        type: string;
        update_strategy: string | null;
      }>(`
        SELECT id, type, from_bundle_id, update_strategy
        FROM public.bundle_events
      `);
      const state = await database.query<{
        from_bundle_nullable: string;
        marker: string;
        shape_check: boolean;
        update_strategy_nullable: string;
        v1_type_check: boolean;
        v2_type_check: boolean;
      }>(`
        SELECT
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.analytics'
          ) AS marker,
          (
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'bundle_events'
              AND column_name = 'from_bundle_id'
          ) AS from_bundle_nullable,
          (
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'bundle_events'
              AND column_name = 'update_strategy'
          ) AS update_strategy_nullable,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.bundle_events'::regclass
              AND conname = 'bundle_events_type_check'
          ) AS v1_type_check,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.bundle_events'::regclass
              AND conname = 'bundle_events_type_v038_check'
              AND convalidated
          ) AS v2_type_check,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.bundle_events'::regclass
              AND conname = 'bundle_events_shape_v038_check'
              AND convalidated
          ) AS shape_check
      `);

      expect(events.rows).toEqual([
        {
          from_bundle_id: "00000000-0000-4000-8000-100000000001",
          id: "00000000-0000-4000-8000-000000000001",
          type: "UPDATE_APPLIED",
          update_strategy: "fingerprint",
        },
      ]);
      expect(state.rows).toEqual([
        {
          from_bundle_nullable: "YES",
          marker: "2",
          shape_check: true,
          update_strategy_nullable: "YES",
          v1_type_check: false,
          v2_type_check: true,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("adopts an unmarked exact v2 schema and preserves its rows", async () => {
    const database = await createPostgres();
    try {
      const contents = analyticsArtifact().contents;
      await database.exec(contents);
      await database.exec(`
        INSERT INTO public.bundle_events (
          id, type, install_id, user_id, username, from_bundle_id,
          to_bundle_id, platform, app_version, channel, cohort,
          update_strategy, fingerprint_hash, sdk_version, received_at_ms
        ) VALUES (
          '00000000-0000-4000-8000-000000000011',
          'UNCHANGED',
          'install-unmarked',
          NULL,
          NULL,
          NULL,
          '00000000-0000-4000-8000-200000000011',
          'android',
          '2.0.0',
          'production',
          'default',
          NULL,
          NULL,
          NULL,
          11
        );
        DELETE FROM public.private_hot_updater_settings
        WHERE key = 'schema.analytics';
      `);

      await database.exec(contents);

      const state = await database.query<{ count: number; marker: string }>(`
        SELECT
          (SELECT count(*)::integer FROM public.bundle_events) AS count,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.analytics'
          ) AS marker
      `);
      expect(state.rows).toEqual([{ count: 1, marker: "2" }]);
    } finally {
      await database.close();
    }
  });

  it("repairs a v1 marker when the physical schema is already v2", async () => {
    const database = await createPostgres();
    try {
      const contents = analyticsArtifact().contents;
      await database.exec(contents);
      await database.exec(`
        INSERT INTO public.bundle_events (
          id, type, install_id, user_id, username, from_bundle_id,
          to_bundle_id, platform, app_version, channel, cohort,
          update_strategy, fingerprint_hash, sdk_version, received_at_ms
        ) VALUES (
          '00000000-0000-4000-8000-000000000021',
          'UNCHANGED',
          'install-marker-recovery',
          NULL,
          NULL,
          NULL,
          '00000000-0000-4000-8000-200000000021',
          'ios',
          '2.0.0',
          'production',
          'default',
          NULL,
          NULL,
          NULL,
          21
        );
        UPDATE public.private_hot_updater_settings
        SET value = '1'
        WHERE key = 'schema.analytics';
      `);

      await database.exec(contents);

      const state = await database.query<{ count: number; marker: string }>(`
        SELECT
          (SELECT count(*)::integer FROM public.bundle_events) AS count,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.analytics'
          ) AS marker
      `);
      expect(state.rows).toEqual([{ count: 1, marker: "2" }]);
    } finally {
      await database.close();
    }
  });

  it("validates beyond 1000 rows and rolls back a corrupt v1 migration", async () => {
    const database = await createPostgres();
    try {
      await seedAnalyticsV1(database, {
        corruptLastRow: true,
        rowCount: 1025,
      });
      const contents = analyticsArtifact().contents;

      const failure = await executeFailedArtifact(database, contents);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "Universal component analytics contains invalid rows in bundle_events",
      );

      const rolledBack = await database.query<{
        count: number;
        from_bundle_nullable: string;
        marker: string;
        v1_check: boolean;
        v2_check: boolean;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM public.bundle_events) AS count,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.analytics'
          ) AS marker,
          (
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'bundle_events'
              AND column_name = 'from_bundle_id'
          ) AS from_bundle_nullable,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.bundle_events'::regclass
              AND conname = 'bundle_events_type_check'
          ) AS v1_check,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.bundle_events'::regclass
              AND conname = 'bundle_events_type_v038_check'
          ) AS v2_check
      `);
      expect(rolledBack.rows).toEqual([
        {
          count: 1025,
          from_bundle_nullable: "NO",
          marker: "1",
          v1_check: true,
          v2_check: false,
        },
      ]);

      await database.exec(`
        UPDATE public.bundle_events SET platform = 'ios'
        WHERE platform = 'web';
      `);
      await database.exec(contents);
      await database.exec(contents);

      const completed = await database.query<{
        count: number;
        marker: string;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM public.bundle_events) AS count,
          (
            SELECT value FROM public.private_hot_updater_settings
            WHERE key = 'schema.analytics'
          ) AS marker
      `);
      expect(completed.rows).toEqual([{ count: 1025, marker: "2" }]);
    } finally {
      await database.close();
    }
  });
});
