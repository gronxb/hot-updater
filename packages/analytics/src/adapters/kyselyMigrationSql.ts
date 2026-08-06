export const KYSELY_ANALYTICS_DIALECTS = [
  "mysql",
  "postgresql",
  "sqlite",
] as const;

export type KyselyAnalyticsDialect = (typeof KYSELY_ANALYTICS_DIALECTS)[number];

export class UnsupportedKyselyAnalyticsDialectError extends Error {
  readonly name = "UnsupportedKyselyAnalyticsDialectError";

  constructor(readonly dialect: string) {
    super(`Unsupported Kysely Analytics dialect: ${dialect}`);
  }
}

function unsupportedDialect(dialect: never): never {
  throw new UnsupportedKyselyAnalyticsDialectError(String(dialect));
}

const v2Checks = [
  "constraint bundle_events_type_v038_check check (type in ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED'))",
  "constraint bundle_events_update_strategy_v038_check check (update_strategy is null or update_strategy in ('fingerprint', 'appVersion'))",
  "constraint bundle_events_shape_v038_check check ((type in ('UPDATE_APPLIED', 'RECOVERED') and from_bundle_id is not null and update_strategy is not null) or (type = 'UNCHANGED' and from_bundle_id is null and update_strategy is null))",
] as const;

const indexDefinitions = [
  {
    name: "bundle_events_installed_bundle_idx",
    columns: ["type", "to_bundle_id", "received_at_ms", "id"],
  },
  {
    name: "bundle_events_recovered_bundle_idx",
    columns: ["type", "from_bundle_id", "received_at_ms", "id"],
  },
  {
    name: "bundle_events_install_idx",
    columns: ["install_id", "received_at_ms", "id"],
  },
  {
    name: "bundle_events_user_id_idx",
    columns: ["user_id", "received_at_ms", "id"],
  },
  {
    name: "bundle_events_username_idx",
    columns: ["username", "received_at_ms", "id"],
  },
  {
    name: "bundle_events_cohort_idx",
    columns: ["cohort", "type", "received_at_ms", "id"],
  },
  {
    name: "bundle_events_received_at_idx",
    columns: ["received_at_ms", "id"],
  },
] as const;

export const ANALYTICS_SQL_COLUMNS = [
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

function identifierType(dialect: KyselyAnalyticsDialect): string {
  switch (dialect) {
    case "sqlite":
      return "text";
    case "mysql":
      return "char(36)";
    case "postgresql":
      return "uuid";
    default:
      return unsupportedDialect(dialect);
  }
}

function timestampType(dialect: KyselyAnalyticsDialect): string {
  switch (dialect) {
    case "sqlite":
      return "real";
    case "mysql":
      return "double";
    case "postgresql":
      return "double precision";
    default:
      return unsupportedDialect(dialect);
  }
}

function tableStatement(
  dialect: KyselyAnalyticsDialect,
  table: string,
): string {
  return `create table ${table} (
  id ${identifierType(dialect)} primary key not null,
  type text not null,
  install_id text not null,
  user_id text,
  username text,
  from_bundle_id ${identifierType(dialect)},
  to_bundle_id ${identifierType(dialect)} not null,
  platform text not null,
  app_version text not null,
  channel text not null,
  cohort text not null,
  update_strategy text,
  fingerprint_hash text,
  sdk_version text,
  received_at_ms ${timestampType(dialect)} not null,
  ${v2Checks.join(",\n  ")}
)`;
}

function indexStatements(dialect: KyselyAnalyticsDialect): readonly string[] {
  return indexDefinitions.map(({ name, columns }) => {
    const indexedColumns = columns.map((column) =>
      dialect === "mysql" &&
      ["type", "install_id", "user_id", "username", "cohort"].includes(column)
        ? `${column}(255)`
        : column,
    );
    return `create index ${name} on bundle_events(${indexedColumns.join(", ")})`;
  });
}

export function createAnalyticsV2Statements(
  dialect: KyselyAnalyticsDialect,
): readonly string[] {
  return [
    tableStatement(dialect, "bundle_events"),
    ...indexStatements(dialect),
  ];
}

const addV2Checks = v2Checks.map(
  (check) => `alter table bundle_events add ${check}`,
);

export function migrateAnalyticsV1Statements(
  dialect: KyselyAnalyticsDialect,
): readonly string[] {
  switch (dialect) {
    case "sqlite": {
      const temporaryTable = "bundle_events_analytics_v2";
      const columns = ANALYTICS_SQL_COLUMNS.join(", ");
      return [
        tableStatement("sqlite", temporaryTable),
        `insert into ${temporaryTable} (${columns}) select ${columns} from bundle_events`,
        "drop table bundle_events",
        `alter table ${temporaryTable} rename to bundle_events`,
        ...indexStatements("sqlite"),
      ];
    }
    case "mysql":
      return [
        "alter table bundle_events alter check bundle_events_type_check not enforced",
        "alter table bundle_events alter check bundle_events_update_strategy_check not enforced",
        "alter table bundle_events modify column from_bundle_id char(36) null",
        "alter table bundle_events modify column update_strategy text null",
        ...addV2Checks,
      ];
    case "postgresql":
      return [
        "alter table bundle_events drop constraint bundle_events_type_check",
        "alter table bundle_events drop constraint bundle_events_update_strategy_check",
        "alter table bundle_events alter column from_bundle_id drop not null",
        "alter table bundle_events alter column update_strategy drop not null",
        ...addV2Checks,
      ];
    default:
      return unsupportedDialect(dialect);
  }
}
