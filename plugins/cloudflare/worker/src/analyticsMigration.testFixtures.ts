import { env } from "cloudflare:test";

const analyticsIndexes = [
  "CREATE INDEX bundle_events_installed_bundle_idx ON bundle_events(type, to_bundle_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_recovered_bundle_idx ON bundle_events(type, from_bundle_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_install_idx ON bundle_events(install_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_user_id_idx ON bundle_events(user_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_username_idx ON bundle_events(username, received_at_ms, id)",
  "CREATE INDEX bundle_events_cohort_idx ON bundle_events(cohort, type, received_at_ms, id)",
  "CREATE INDEX bundle_events_received_at_idx ON bundle_events(received_at_ms, id)",
] as const;

const commonColumns = `
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  install_id TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
`;

const trailingColumns = `
  to_bundle_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  cohort TEXT NOT NULL,
`;

const commonTail = `
  fingerprint_hash TEXT,
  sdk_version TEXT,
  received_at_ms REAL NOT NULL
`;

export const resetAnalyticsDatabase = async (): Promise<void> => {
  await env.DB.batch(
    [
      "DROP TABLE IF EXISTS bundle_events",
      "DROP TABLE IF EXISTS bundle_events_analytics_v2",
      "DROP TABLE IF EXISTS analytics_index_conflict",
      "DROP TABLE IF EXISTS private_hot_updater_settings",
    ].map((sql) => env.DB.prepare(sql)),
  );
};

export const createCoreSettings = async (
  legacyVersion: "0.36.0" | "0.37.0" | "0.38.0",
  componentVersion?: "2" | "3",
): Promise<void> => {
  await env.DB.prepare(`
    CREATE TABLE private_hot_updater_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(
    "INSERT INTO private_hot_updater_settings (key, value) VALUES ('version', ?)",
  )
    .bind(legacyVersion)
    .run();
  if (componentVersion !== undefined) {
    await env.DB.prepare(
      "INSERT INTO private_hot_updater_settings (key, value) VALUES ('schema.analytics', ?)",
    )
      .bind(componentVersion)
      .run();
  }
};

export const createLegacyV1AnalyticsSchema = async (): Promise<void> => {
  await env.DB.prepare(`
    CREATE TABLE bundle_events (
      ${commonColumns}
      from_bundle_id TEXT NOT NULL,
      ${trailingColumns}
      update_strategy TEXT NOT NULL,
      ${commonTail},
      CONSTRAINT bundle_events_type_check
        CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED')),
      CONSTRAINT bundle_events_update_strategy_check
        CHECK (update_strategy IN ('fingerprint', 'appVersion'))
    )
  `).run();
  await env.DB.batch(analyticsIndexes.map((sql) => env.DB.prepare(sql)));
};

export const createLegacyV2AnalyticsSchema = async (
  updateStrategyLiterals: {
    readonly fingerprint: "finger print" | "fingerprint";
    readonly appVersion: "appVersion" | "appversion";
  } = { fingerprint: "fingerprint", appVersion: "appVersion" },
): Promise<void> => {
  await env.DB.prepare(`
    CREATE TABLE bundle_events (
      ${commonColumns}
      from_bundle_id TEXT,
      ${trailingColumns}
      update_strategy TEXT,
      ${commonTail},
      CONSTRAINT bundle_events_type_v038_check
        CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
      CONSTRAINT bundle_events_update_strategy_v038_check
        CHECK (update_strategy IS NULL OR update_strategy IN ('${updateStrategyLiterals.fingerprint}', '${updateStrategyLiterals.appVersion}')),
      CONSTRAINT bundle_events_shape_v038_check
        CHECK (
          (type IN ('UPDATE_APPLIED', 'RECOVERED')
            AND from_bundle_id IS NOT NULL
            AND update_strategy IS NOT NULL)
          OR (type = 'UNCHANGED'
            AND from_bundle_id IS NULL
          AND update_strategy IS NULL)
        )
    )
  `).run();
  await env.DB.batch(analyticsIndexes.map((sql) => env.DB.prepare(sql)));
};

export const insertLegacyTransition = async (): Promise<void> => {
  await env.DB.prepare(`
    INSERT INTO bundle_events (
      id, type, install_id, user_id, username, from_bundle_id, to_bundle_id,
      platform, app_version, channel, cohort, update_strategy,
      fingerprint_hash, sdk_version, received_at_ms
    ) VALUES (
      'legacy-event', 'UPDATE_APPLIED', 'install-1', NULL, NULL,
      'bundle-a', 'bundle-b', 'ios', '1.0.0', 'production', 'stable',
      'fingerprint', NULL, NULL, 100
    )
  `).run();
};

export const readAnalyticsMarker = async (): Promise<string | null> =>
  env.DB.prepare(
    "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.analytics'",
  ).first<string>("value");
