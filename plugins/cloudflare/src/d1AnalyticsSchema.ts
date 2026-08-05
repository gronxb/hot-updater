export const d1AnalyticsColumns = [
  "id",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_bundle_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
  "received_at_ms",
] as const;

export const d1AnalyticsTableV1 = `CREATE TABLE bundle_events (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    install_id TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    from_bundle_id TEXT NOT NULL,
    to_bundle_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    cohort TEXT NOT NULL,
    update_strategy TEXT NOT NULL,
    fingerprint_hash TEXT,
    sdk_version TEXT,
    received_at_ms REAL NOT NULL,
    CONSTRAINT bundle_events_type_check
      CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED')),
    CONSTRAINT bundle_events_update_strategy_check
      CHECK (update_strategy IN ('fingerprint', 'appVersion'))
  )`;

const createV2Table = (tableName: string): string =>
  `CREATE TABLE ${tableName} (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    install_id TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    from_bundle_id TEXT,
    to_bundle_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    cohort TEXT NOT NULL,
    update_strategy TEXT,
    fingerprint_hash TEXT,
    sdk_version TEXT,
    received_at_ms REAL NOT NULL,
    CONSTRAINT bundle_events_type_v038_check
      CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
    CONSTRAINT bundle_events_update_strategy_v038_check
      CHECK (update_strategy IS NULL OR update_strategy IN ('fingerprint', 'appVersion')),
    CONSTRAINT bundle_events_shape_v038_check
      CHECK (
        (type IN ('UPDATE_APPLIED', 'RECOVERED')
          AND from_bundle_id IS NOT NULL
          AND update_strategy IS NOT NULL)
        OR (type = 'UNCHANGED'
          AND from_bundle_id IS NULL
          AND update_strategy IS NULL)
      )
  )`;

export const d1AnalyticsTableV2 = createV2Table("bundle_events");
export const d1AnalyticsMigrationTableV2 = createV2Table(
  "bundle_events_analytics_v2",
);

export const d1AnalyticsIndexes = [
  "CREATE INDEX bundle_events_installed_bundle_idx ON bundle_events(type, to_bundle_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_recovered_bundle_idx ON bundle_events(type, from_bundle_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_install_idx ON bundle_events(install_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_user_id_idx ON bundle_events(user_id, received_at_ms, id)",
  "CREATE INDEX bundle_events_username_idx ON bundle_events(username, received_at_ms, id)",
  "CREATE INDEX bundle_events_cohort_idx ON bundle_events(cohort, type, received_at_ms, id)",
  "CREATE INDEX bundle_events_received_at_idx ON bundle_events(received_at_ms, id)",
] as const;

export const normalizeD1SchemaSql = (sql: string): string => {
  let normalized = "";
  let index = 0;
  while (index < sql.length) {
    const remaining = sql.slice(index);
    const optionalCreationClause = remaining.match(/^if\s+not\s+exists\b/i);
    if (optionalCreationClause !== null) {
      index += optionalCreationClause[0].length;
      continue;
    }
    const character = sql[index];
    if (character === "'") {
      normalized += character;
      index += 1;
      while (index < sql.length) {
        const literalCharacter = sql[index];
        normalized += literalCharacter;
        index += 1;
        if (literalCharacter === "'" && sql[index] === "'") {
          normalized += sql[index];
          index += 1;
          continue;
        }
        if (literalCharacter === "'") break;
      }
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const closingCharacter = character === "[" ? "]" : character;
      index += 1;
      while (index < sql.length) {
        const identifierCharacter = sql[index];
        index += 1;
        if (identifierCharacter === closingCharacter) {
          if (sql[index] === closingCharacter && character !== "[") {
            normalized += closingCharacter;
            index += 1;
            continue;
          }
          break;
        }
        if (identifierCharacter !== undefined) {
          normalized += identifierCharacter.toLowerCase();
        }
      }
      continue;
    }
    if (character !== undefined && !/\s/.test(character)) {
      normalized += character.toLowerCase();
    }
    index += 1;
  }
  return normalized;
};
