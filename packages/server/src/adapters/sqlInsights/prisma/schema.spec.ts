import { describe, expect, it } from "vitest";

import type { ORMSQLProvider } from "../../../db/types";
import { PrismaInsightsSql, type PrismaInsightsRawClient } from "./client";
import {
  getExpectedPrismaInsightsCatalog,
  getPrismaInsightsSchemaSql,
  hasCompletePrismaInsightsLayout,
  PRISMA_INSIGHTS_REQUIRED_INDEXES,
} from "./schema";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000e005";

const providers: readonly ORMSQLProvider[] = [
  "sqlite",
  "cockroachdb",
  "mysql",
  "postgresql",
  "mssql",
];

const indexOwners: Readonly<Record<string, string>> = {
  private_hot_updater_prisma_insights_events_global_idx:
    "private_hot_updater_prisma_insights_events",
  private_hot_updater_prisma_insights_events_install_idx:
    "private_hot_updater_prisma_insights_events",
  private_hot_updater_prisma_insights_events_to_bundle_idx:
    "private_hot_updater_prisma_insights_events",
  private_hot_updater_prisma_insights_events_from_bundle_idx:
    "private_hot_updater_prisma_insights_events",
  private_hot_updater_prisma_insights_aliases_source_idx:
    "private_hot_updater_prisma_insights_aliases",
  private_hot_updater_prisma_search_jobs_state_idx:
    "private_hot_updater_prisma_insights_search_jobs",
  private_hot_updater_prisma_report_jobs_state_idx:
    "private_hot_updater_prisma_insights_report_jobs",
  private_hot_updater_prisma_report_members_page_idx:
    "private_hot_updater_prisma_insights_report_members",
  private_hot_updater_prisma_report_order_page_idx:
    "private_hot_updater_prisma_insights_report_order",
  private_hot_updater_prisma_report_counts_source_idx:
    "private_hot_updater_prisma_insights_report_counts",
  private_hot_updater_prisma_report_sort_page_idx:
    "private_hot_updater_prisma_insights_report_sort",
  private_hot_updater_prisma_insights_legacy_id_idx: "bundle_events",
};

const indexKeys: Readonly<Record<string, readonly string[]>> = {
  private_hot_updater_prisma_insights_events_global_idx: [
    "received_at_ms",
    "event_order",
  ],
  private_hot_updater_prisma_insights_events_install_idx: [
    "install_key",
    "type",
    "received_at_ms",
    "event_order",
  ],
  private_hot_updater_prisma_insights_events_to_bundle_idx: [
    "type",
    "to_bundle_id",
    "received_at_ms",
    "event_order",
  ],
  private_hot_updater_prisma_insights_events_from_bundle_idx: [
    "type",
    "from_bundle_id",
    "received_at_ms",
    "event_order",
  ],
  private_hot_updater_prisma_insights_aliases_source_idx: [
    "source_generation",
    "alias_key",
  ],
  private_hot_updater_prisma_search_jobs_state_idx: ["state", "id"],
  private_hot_updater_prisma_report_jobs_state_idx: ["state", "id"],
  private_hot_updater_prisma_report_members_page_idx: [
    "job_id",
    "section",
    "metric",
    "member_key",
  ],
  private_hot_updater_prisma_report_order_page_idx: [
    "job_id",
    "order_kind",
    "metric",
    "ordinal",
  ],
  private_hot_updater_prisma_report_counts_source_idx: [
    "job_id",
    "section",
    "metric",
    "bucket_start_ms",
    "count_key",
  ],
  private_hot_updater_prisma_report_sort_page_idx: [
    "job_id",
    "order_kind",
    "metric",
    "sort_pass",
    "sort_run",
    "ordinal",
  ],
};

const isDescending = (name: string, position: number): boolean =>
  name.includes("insights_events_") &&
  position >= (name.endsWith("global_idx") ? 0 : 2);

const migrationExpression: Readonly<Record<ORMSQLProvider, string>> = {
  postgresql: 'id collate "C"',
  cockroachdb: "private_hot_updater_prisma_insights_migration_id",
  mysql: "cast(id as binary)",
  sqlite: "cast(id as blob)",
  mssql: "convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),id)))",
};

const sourceGenerationCatalogRow = (
  provider: ORMSQLProvider,
): Record<string, unknown> => {
  const common = {
    name: "private_events_source_generation_unique",
    table_name: "private_hot_updater_prisma_insights_events",
    column_name: "source_generation",
  };
  switch (provider) {
    case "sqlite":
      return {
        ...common,
        is_unique: 1,
        origin: "u",
        partial: 0,
        key_ordinal: 0,
        is_descending: 0,
        index_sql: null,
      };
    case "postgresql":
      return {
        ...common,
        is_unique: true,
        is_valid: true,
        is_ready: true,
        is_partial: false,
        key_ordinal: 1,
        key_definition: "source_generation",
        index_definition: "create unique index source on events",
        is_descending: false,
      };
    case "cockroachdb":
      return {
        ...common,
        non_unique: "NO",
        key_ordinal: 1,
        direction: "ASC",
        implicit: "NO",
        storing: "NO",
      };
    case "mysql":
      return {
        ...common,
        non_unique: 0,
        key_ordinal: 1,
        expression: null,
        collation: "A",
        sub_part: null,
      };
    case "mssql":
      return {
        ...common,
        is_unique: 1,
        is_disabled: 0,
        has_filter: 0,
        key_ordinal: 1,
        is_descending_key: 0,
        computed_definition: null,
        is_persisted: null,
      };
  }
};

const catalogRows = (provider: ORMSQLProvider): Record<string, unknown>[] => [
  ...PRISMA_INSIGHTS_REQUIRED_INDEXES.flatMap((name) => {
    const keys =
      name === "private_hot_updater_prisma_insights_legacy_id_idx"
        ? [migrationExpression[provider]]
        : indexKeys[name]!;
    return keys.map((key, position) => {
      const descending = isDescending(name, position);
      const unique = name === "private_hot_updater_prisma_report_sort_page_idx";
      if (provider === "sqlite") {
        return {
          name,
          table_name: indexOwners[name],
          is_unique: unique ? 1 : 0,
          origin: "c",
          partial: 0,
          key_ordinal: position,
          column_name:
            name === "private_hot_updater_prisma_insights_legacy_id_idx"
              ? null
              : key,
          is_descending: descending ? 1 : 0,
          index_sql:
            name === "private_hot_updater_prisma_insights_legacy_id_idx"
              ? `create index ${name} on bundle_events (${key})`
              : `create index ${name}`,
        };
      }
      if (provider === "postgresql") {
        return {
          name,
          table_name: indexOwners[name],
          is_unique: unique,
          is_valid: true,
          is_ready: true,
          is_partial: false,
          key_ordinal: position + 1,
          key_definition: descending ? `${key} desc` : key,
          index_definition:
            name === "private_hot_updater_prisma_insights_legacy_id_idx"
              ? `create index ${name} on bundle_events (${key})`
              : `create index ${name}`,
          is_descending: descending,
        };
      }
      if (provider === "cockroachdb") {
        return {
          name,
          table_name: indexOwners[name],
          non_unique: unique ? "NO" : "YES",
          key_ordinal: position + 1,
          column_name:
            name === "private_hot_updater_prisma_insights_legacy_id_idx"
              ? "private_hot_updater_prisma_insights_migration_id"
              : key,
          direction: descending ? "DESC" : "ASC",
          implicit: "NO",
          storing: "NO",
        };
      }
      if (provider === "mysql") {
        return {
          name,
          table_name: indexOwners[name],
          non_unique: unique ? 0 : 1,
          key_ordinal: position + 1,
          column_name:
            name === "private_hot_updater_prisma_insights_legacy_id_idx"
              ? null
              : key,
          expression:
            name === "private_hot_updater_prisma_insights_legacy_id_idx"
              ? "cast(`id` as char charset binary)"
              : null,
          collation: descending ? "D" : "A",
          sub_part: null,
        };
      }
      return {
        name,
        table_name: indexOwners[name],
        is_unique:
          name === "private_hot_updater_prisma_insights_legacy_id_idx"
            ? 1
            : unique
              ? 1
              : 0,
        is_disabled: 0,
        has_filter: 0,
        key_ordinal: position + 1,
        column_name:
          name === "private_hot_updater_prisma_insights_legacy_id_idx"
            ? "private_hot_updater_prisma_insights_migration_id"
            : key,
        is_descending_key: descending ? 1 : 0,
        computed_definition:
          name === "private_hot_updater_prisma_insights_legacy_id_idx"
            ? key
            : null,
        is_persisted:
          name === "private_hot_updater_prisma_insights_legacy_id_idx"
            ? 1
            : null,
      };
    });
  }),
  sourceGenerationCatalogRow(provider),
];

const mysqlTables = [
  "bundle_events",
  "private_hot_updater_prisma_insights_ddl",
  "private_hot_updater_prisma_insights_state",
  "private_hot_updater_prisma_insights_source",
  "private_hot_updater_prisma_insights_events",
  "private_hot_updater_prisma_insights_live",
  "private_hot_updater_prisma_insights_aliases",
  "private_hot_updater_prisma_insights_search_heads",
  "private_hot_updater_prisma_insights_search_jobs",
  "private_hot_updater_prisma_insights_search_rows",
  "private_hot_updater_prisma_insights_report_heads",
  "private_hot_updater_prisma_insights_report_jobs",
  "private_hot_updater_prisma_insights_report_members",
  "private_hot_updater_prisma_insights_report_latest",
  "private_hot_updater_prisma_insights_report_counts",
  "private_hot_updater_prisma_insights_report_order",
  "private_hot_updater_prisma_insights_report_sort",
  "private_hot_updater_prisma_insights_report_seals",
];

const catalogClient = (
  provider: ORMSQLProvider,
  rows: readonly Record<string, unknown>[],
  cockroachMigrationExpression = "id::STRING::BYTES",
  queries?: string[],
): PrismaInsightsRawClient => ({
  $executeRawUnsafe: async () => 0,
  $queryRawUnsafe: async <TResult>(query: string): Promise<TResult> => {
    queries?.push(query);
    if (query.includes("select source_id from")) {
      return [{ source_id: insightsDatabaseNamespace }] as TResult;
    }
    const expected = getExpectedPrismaInsightsCatalog(provider);
    if (query.includes("sqlite_master where type='table'")) {
      return getPrismaInsightsSchemaSql("sqlite").flatMap((sql) => {
        const match =
          /create\s+table(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)/i.exec(sql);
        return match?.[1]?.startsWith("private_hot_updater_prisma_insights_")
          ? [{ name: match[1], sql }]
          : [];
      }) as TResult;
    }
    if (
      query.includes("pragma_foreign_key_list") ||
      query.includes("constraint_type not in")
    ) {
      return [] as TResult;
    }
    if (query.includes("information_schema.columns")) {
      return expected.flatMap((table) =>
        table.columns.map((column) => ({
          table_name: table.name,
          column_name: column.name,
          column_type: column.type,
          is_nullable: column.nullable ? "YES" : "NO",
          collation_name: column.collation,
          column_default: column.defaultValue,
        })),
      ) as TResult;
    }
    if (query.includes("information_schema.key_column_usage kcu")) {
      return expected.flatMap((table) =>
        table.keys.flatMap((key, constraintIndex) => {
          const separator = key.indexOf(":");
          const type = key.slice(0, separator);
          return key
            .slice(separator + 1)
            .split(",")
            .map((column_name, index) => ({
              table_name: table.name,
              constraint_name: `constraint_${constraintIndex}`,
              constraint_type: type,
              column_name,
              ordinal_position: index + 1,
            }));
        }),
      ) as TResult;
    }
    if (
      query.includes("pg_get_constraintdef") ||
      query.includes("sys.check_constraints") ||
      query.includes("information_schema.check_constraints cc")
    ) {
      return expected.flatMap((table) =>
        table.checks.map((check_clause) => ({
          table_name: table.name,
          check_clause,
        })),
      ) as TResult;
    }
    if (
      query.includes("indexes.type='index'") ||
      query.includes("left join pg_constraint") ||
      query.includes("indexes.is_primary_key=0") ||
      query.includes("left join information_schema.table_constraints")
    ) {
      return PRISMA_INSIGHTS_REQUIRED_INDEXES.map((name) => ({
        name,
      })) as TResult;
    }
    if (query.includes("show create table bundle_events")) {
      return [
        {
          create_statement: `CREATE TABLE bundle_events (private_hot_updater_prisma_insights_migration_id BYTES NULL AS (${cockroachMigrationExpression}) STORED)`,
        },
      ] as TResult;
    }
    if (query.includes("information_schema.tables")) {
      return mysqlTables.map((table_name) => ({
        table_name,
        engine: "InnoDB",
      })) as TResult;
    }
    return rows as TResult;
  },
});

describe("Prisma Insights native layouts", () => {
  it.each(providers)(
    "defines bounded indexed source paths for %s",
    (provider) => {
      const sql = getPrismaInsightsSchemaSql(provider).join("\n").toLowerCase();

      expect(sql).toContain("source_generation");
      expect(sql).toContain("source_id");
      expect(sql).toContain("event_json");
      expect(sql).toContain("install_key");
      expect(sql).toContain("events_global_idx");
      expect(sql).toContain("events_install_idx");
      expect(sql).toContain("events_to_bundle_idx");
      expect(sql).toContain("events_from_bundle_idx");
      for (const index of PRISMA_INSIGHTS_REQUIRED_INDEXES) {
        expect(sql).toContain(index);
      }
      expect(sql).toContain("lease_owner");
      expect(sql).toContain("lease_version");
      expect(sql).toContain("order_totals_json");
      expect(sql).not.toContain(" offset ");
      expect(sql).not.toContain(" scan ");
    },
  );

  it("keeps the full SQL Server UTF-16 key out of index keys", () => {
    const sql = getPrismaInsightsSchemaSql("mssql").join("\n").toLowerCase();

    expect(sql).toContain("label_order varbinary(2048)");
    expect(sql).toContain(
      "private_hot_updater_prisma_report_counts_source_idx",
    );
    expect(sql).toContain("job_id,section,metric,bucket_start_ms,count_key");
    expect(sql).toContain("private_hot_updater_prisma_report_sort_page_idx");
    expect(sql).not.toContain("report_counts_label_idx");
    expect(sql).not.toContain("report_counts_value_idx");
  });

  it.each([
    ["postgresql", 'id collate "c"'],
    ["cockroachdb", "id::string::bytes"],
    ["mysql", "cast(id as binary)"],
    ["sqlite", "cast(id as blob)"],
    ["mssql", "private_hot_updater_prisma_insights_migration_id"],
  ] as const)(
    "defines an explicit binary legacy key for %s",
    (provider, key) => {
      expect(
        getPrismaInsightsSchemaSql(provider).join("\n").toLowerCase(),
      ).toContain(key);
    },
  );

  it.each([
    ["postgresql", "$1"],
    ["cockroachdb", "$1"],
    ["mysql", "?"],
    ["sqlite", "?"],
    ["mssql", "@P1"],
  ] as const)(
    "binds %s values with native placeholders",
    (provider, placeholder) => {
      const statement = new PrismaInsightsSql(provider);
      expect(statement.value("secret-value")).toBe(placeholder);
      expect(statement.statement("select value").values).toEqual([
        "secret-value",
      ]);
    },
  );

  it.each(providers)(
    "accepts only the exact native %s index catalog",
    async (provider) => {
      const rows = catalogRows(provider);
      await expect(
        hasCompletePrismaInsightsLayout(
          catalogClient(provider, rows),
          provider,
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(true);

      const missingSourceGenerationIndex = rows.filter(
        (row) => row.name !== "private_events_source_generation_unique",
      );
      await expect(
        hasCompletePrismaInsightsLayout(
          catalogClient(provider, missingSourceGenerationIndex),
          provider,
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);

      const nonUniqueSourceGenerationIndex = rows.map((row) => {
        if (row.name !== "private_events_source_generation_unique") return row;
        return provider === "cockroachdb" || provider === "mysql"
          ? { ...row, non_unique: 1 }
          : { ...row, is_unique: 0 };
      });
      await expect(
        hasCompletePrismaInsightsLayout(
          catalogClient(provider, nonUniqueSourceGenerationIndex),
          provider,
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);

      const malformedKeys = rows.map((row) =>
        row.name === "private_hot_updater_prisma_insights_events_global_idx" &&
        row.key_ordinal === 1
          ? provider === "postgresql"
            ? { ...row, key_definition: "event_order", is_descending: false }
            : provider === "cockroachdb"
              ? { ...row, column_name: "event_order", direction: "ASC" }
              : provider === "mysql"
                ? { ...row, column_name: "event_order", collation: "A" }
                : provider === "sqlite"
                  ? { ...row, column_name: "event_order", is_descending: 0 }
                  : {
                      ...row,
                      column_name: "event_order",
                      is_descending_key: 0,
                    }
          : row,
      );
      await expect(
        hasCompletePrismaInsightsLayout(
          catalogClient(provider, malformedKeys),
          provider,
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);

      const malformedUniqueness = rows.map((row) =>
        row.name === "private_hot_updater_prisma_report_sort_page_idx"
          ? provider === "cockroachdb" || provider === "mysql"
            ? { ...row, non_unique: true }
            : { ...row, is_unique: 0 }
          : row,
      );
      await expect(
        hasCompletePrismaInsightsLayout(
          catalogClient(provider, malformedUniqueness),
          provider,
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);

      const malformedMigration = rows.map((row) =>
        row.name === "private_hot_updater_prisma_insights_legacy_id_idx"
          ? provider === "postgresql"
            ? {
                ...row,
                index_definition: "create index legacy on bundle_events (id)",
              }
            : provider === "mysql"
              ? { ...row, expression: "cast(id as char)" }
              : provider === "sqlite"
                ? {
                    ...row,
                    index_sql:
                      "create index legacy on bundle_events (cast(id as text))",
                  }
                : provider === "mssql"
                  ? {
                      ...row,
                      computed_definition:
                        "convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),other_id)))",
                    }
                  : row
          : row,
      );
      await expect(
        hasCompletePrismaInsightsLayout(
          catalogClient(
            provider,
            malformedMigration,
            provider === "cockroachdb" ? "id::STRING" : undefined,
          ),
          provider,
          insightsDatabaseNamespace,
        ),
      ).resolves.toBe(false);
    },
  );

  it("aliases every MySQL catalog field Prisma returns in uppercase", async () => {
    const queries: string[] = [];
    await expect(
      hasCompletePrismaInsightsLayout(
        catalogClient("mysql", catalogRows("mysql"), undefined, queries),
        "mysql",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(true);
    const indexQuery = queries.find((query) =>
      query.includes("non_unique as non_unique"),
    );
    expect(indexQuery).toContain("seq_in_index as key_ordinal");
    expect(indexQuery).toContain("column_name as column_name");
    expect(indexQuery).toContain("expression as expression");
    expect(indexQuery).toContain("collation as collation");
    expect(indexQuery).toContain("sub_part as sub_part");
  });

  it("ignores CockroachDB implicit and stored catalog rows", async () => {
    const rows = [
      ...catalogRows("cockroachdb"),
      {
        name: "private_hot_updater_prisma_insights_legacy_id_idx",
        table_name: "bundle_events",
        non_unique: "YES",
        key_ordinal: 2,
        column_name: "id",
        direction: "ASC",
        implicit: "YES",
        storing: "NO",
      },
      {
        name: "private_hot_updater_prisma_report_sort_page_idx",
        table_name: "private_hot_updater_prisma_insights_report_sort",
        non_unique: "NO",
        key_ordinal: 7,
        column_name: "rowid",
        direction: "N/A",
        implicit: "YES",
        storing: "YES",
      },
    ];
    await expect(
      hasCompletePrismaInsightsLayout(
        catalogClient("cockroachdb", rows),
        "cockroachdb",
        insightsDatabaseNamespace,
      ),
    ).resolves.toBe(true);
  });
});
