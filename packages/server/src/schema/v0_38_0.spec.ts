import { describe, expect, it } from "vitest";

import { createTableSql } from "../db/schema/sql";
import { createV038AlterSql } from "../db/schema/sqlMigrations";
import {
  generateDrizzleSchema,
  generatePrismaSchema,
} from "../db/schemaGenerators";
import { bundlesV038, channelsV038, v0_38_0 } from "./v0_38_0";

describe("v0.38.0 normalized Channel schema", () => {
  it("keeps the legacy channel name beside a required Channel reference", () => {
    expect(v0_38_0.version).toBe("0.38.0");
    expect(v0_38_0.tables.map(({ ormName }) => ormName)).toEqual([
      "channels",
      "bundles",
      "bundle_patches",
      "bundle_events",
      "client_access_keys",
      "private_hot_updater_settings",
    ]);
    expect(channelsV038.columns).toEqual([
      {
        ormName: "id",
        type: "varchar(255)",
        providerCollations: {
          mysql: "utf8mb4_bin",
          mssql: "Latin1_General_100_BIN2_SC",
          sqlite: "binary",
        },
        primaryKey: true,
      },
      {
        ormName: "name",
        type: "varchar(255)",
        providerCollations: {
          mysql: "utf8mb4_bin",
          mssql: "Latin1_General_100_BIN2_SC",
          sqlite: "binary",
        },
      },
    ]);
    expect(channelsV038.indexes).toEqual([
      {
        name: "channels_name_key",
        columns: ["name"],
        unique: true,
      },
    ]);
    expect(channelsV038.checks).toEqual([
      expect.objectContaining({
        name: "channels_id_length_check",
        expression: "char_length(id) between 1 and 255",
      }),
      expect.objectContaining({
        name: "channels_name_length_check",
        expression: "char_length(name) between 1 and 255",
      }),
    ]);
    expect(bundlesV038.columns).toContainEqual({
      ormName: "channel_id",
      type: "varchar(255)",
      providerCollations: {
        mysql: "utf8mb4_bin",
        mssql: "Latin1_General_100_BIN2_SC",
        sqlite: "binary",
      },
    });
    expect(bundlesV038.foreignKeys).toEqual([
      {
        name: "bundles_channel_id_fk",
        columns: ["channel_id"],
        referencedTable: "channels",
        referencedColumns: ["id"],
        onUpdate: "restrict",
        onDelete: "restrict",
      },
    ]);
  });

  it.each(["postgresql", "cockroachdb", "mysql", "mssql"] as const)(
    "backfills and validates %s before applying constraints",
    (provider) => {
      const statements = createV038AlterSql(provider);
      const indexOf = (fragment: string) =>
        statements.findIndex((statement) => statement.includes(fragment));

      expect(
        indexOf(
          provider === "mssql"
            ? "object_id(N'channels'"
            : "create table if not exists channels",
        ),
      ).toBeGreaterThanOrEqual(0);
      expect(indexOf("add column channel_id")).toBeGreaterThanOrEqual(0);
      expect(indexOf("insert into channels")).toBeGreaterThan(
        indexOf("add column channel_id"),
      );
      expect(indexOf("update bundles set channel_id")).toBeGreaterThan(
        indexOf("insert into channels"),
      );
      expect(
        indexOf("hot_updater_channel_backfill_is_complete"),
      ).toBeGreaterThan(indexOf("update bundles set channel_id"));
      expect(indexOf("channels_name_key")).toBeGreaterThan(
        indexOf("hot_updater_channel_backfill_is_complete"),
      );
      const notNull = statements.findIndex(
        (statement) =>
          statement.startsWith("alter table bundles") &&
          statement.includes("channel_id") &&
          statement.includes("not null"),
      );
      expect(notNull).toBeGreaterThan(indexOf("channels_name_key"));
      expect(indexOf("bundles_channel_id_fk")).toBeGreaterThan(notNull);
    },
  );

  it("rebuilds SQLite only after validating the legacy Channel mapping", () => {
    const statements = createV038AlterSql("sqlite");
    const validation = statements.findIndex((statement) =>
      statement.includes("hot_updater_channel_backfill_is_complete"),
    );
    const rebuild = statements.findIndex((statement) =>
      statement.startsWith("create table bundles_v038"),
    );

    expect(validation).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThan(validation);
    expect(statements[rebuild]).toContain(
      "channel_id text collate binary not null",
    );
    expect(statements[rebuild]).toContain(
      "constraint bundles_channel_id_fk foreign key (channel_id) references channels(id)",
    );
    expect(statements).toContain("pragma foreign_key_check");
  });

  it("generates Channel relations and both bundle Channel columns", () => {
    const prisma = generatePrismaSchema("postgresql", v0_38_0);
    const drizzle = generateDrizzleSchema("postgresql", v0_38_0);

    expect(prisma).toContain("model channels {");
    expect(prisma).toContain('@@unique([name], map: "channels_name_key")');
    expect(prisma).toContain('channel String @default("production")');
    expect(prisma).toContain("channel_id String @db.VarChar(255)");
    expect(prisma).toContain(
      'channelRecord channels @relation("bundles_channels"',
    );
    expect(drizzle).toContain('export const channels = pgTable("channels"');
    expect(drizzle).toContain(
      'uniqueIndex("channels_name_key").on(table.name)',
    );
    expect(drizzle).toContain('channel_id: varchar("channel_id"');
    expect(drizzle).toContain('name: "bundles_channel_id_fk"');
  });

  it("renders portable Unicode length constraints", () => {
    const sqlite = createV038AlterSql("sqlite").join("\n");
    const postgresql = createV038AlterSql("postgresql").join("\n");
    const mssql = createV038AlterSql("mssql").join("\n");

    expect(sqlite).toContain("length(channel) > 255");
    expect(sqlite).toContain("length(name) between 1 and 255");
    expect(postgresql).toContain("char_length(channel) > 255");
    expect(postgresql).toContain("char_length(name) between 1 and 255");
    expect(mssql).toContain(
      "len(channel collate Latin1_General_100_BIN2_SC + N'#') - 1",
    );
    expect(mssql).toContain(
      "name nvarchar(255) collate Latin1_General_100_BIN2_SC not null",
    );
  });

  it("generates case-sensitive normalized Channel columns for each SQL dialect that needs an explicit collation", () => {
    const mysql = createTableSql("mysql").join("\n");
    const mssql = createTableSql("mssql").join("\n");
    const sqlite = createTableSql("sqlite").join("\n");

    expect(mysql).toContain(
      "id varchar(255) character set utf8mb4 collate utf8mb4_bin primary key not null",
    );
    expect(mysql).toContain(
      "name varchar(255) character set utf8mb4 collate utf8mb4_bin not null",
    );
    expect(mysql).toContain(
      "channel_id varchar(255) character set utf8mb4 collate utf8mb4_bin not null",
    );
    expect(mssql).toContain(
      "name nvarchar(255) collate Latin1_General_100_BIN2_SC not null",
    );
    expect(mssql).toContain(
      "channel_id nvarchar(255) collate Latin1_General_100_BIN2_SC not null",
    );
    expect(sqlite).toContain("name text collate binary not null");
    expect(sqlite).toContain("channel_id text collate binary not null");
  });

  it("uses case-sensitive legacy-name comparisons while backfilling", () => {
    expect(createV038AlterSql("mysql").join("\n")).toContain(
      "distinct convert(channel using utf8mb4) collate utf8mb4_bin as channel",
    );
    expect(createV038AlterSql("mssql").join("\n")).toContain(
      "distinct channel collate Latin1_General_100_BIN2_SC as channel",
    );
    expect(createV038AlterSql("sqlite").join("\n")).toContain(
      "distinct channel collate binary as channel",
    );
  });

  it("keeps the Channel reference as a validated logical invariant in fumadb mode", () => {
    const statements = createV038AlterSql("postgresql", "fumadb");
    const migration = statements.join("\n");

    expect(migration).toContain(
      "channels.id = bundles.channel_id and channels.name = bundles.channel",
    );
    expect(migration).toContain(
      "alter table bundles alter column channel_id set not null",
    );
    expect(migration).not.toContain("bundles_channel_id_fk");
  });
});
