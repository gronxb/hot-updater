import type { HotUpdaterVersionedSchema } from "../../schema/types";
import type { ORMSQLProvider } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";
import { assertV038MigrationSchemaDriftIsAllowlisted } from "./schemaDriftValidatorV038";
import {
  createCheckSql,
  createIndexSql,
  createTableStatement,
  getSqlType,
} from "./sql";

type V038Migration = {
  readonly previous: HotUpdaterVersionedSchema;
  readonly next: HotUpdaterVersionedSchema;
  readonly provider: ORMSQLProvider;
};

const oldCheckNames = [
  "bundle_events_type_check",
  "bundle_events_update_strategy_check",
] as const;

export const createV038MigrationSql = ({
  previous,
  next,
  provider,
}: V038Migration): readonly string[] => {
  assertV038MigrationSchemaDriftIsAllowlisted(previous, next);
  const bundleEvents = next.tables.find(
    (table) => table.ormName === "bundle_events",
  );
  if (!bundleEvents) {
    throw new Error("Hot Updater schema version 0.38.0 is incomplete.");
  }
  const checks = (bundleEvents.checks ?? []).map((check) =>
    createCheckSql(bundleEvents, check),
  );

  switch (provider) {
    case "sqlite": {
      const columns = bundleEvents.columns.map((column) => column.ormName);
      const createTable = createTableStatement(bundleEvents, provider).replace(
        /^create table if not exists bundle_events/i,
        "create table bundle_events_v038",
      );
      const indexes = (bundleEvents.indexes ?? [])
        .filter((index) => schemaIndexAppliesToProvider(index, provider))
        .map((index) => createIndexSql(bundleEvents, index, provider));
      return [
        "pragma foreign_keys = off",
        createTable,
        `insert into bundle_events_v038 (${columns.join(", ")}) select ${columns.join(", ")} from bundle_events`,
        "drop table bundle_events",
        "alter table bundle_events_v038 rename to bundle_events",
        ...indexes,
        "pragma foreign_key_check",
        "pragma foreign_keys = on",
      ];
    }
    case "mysql":
      return [
        ...oldCheckNames.map(
          (name) =>
            `alter table bundle_events alter check ${name} not enforced`,
        ),
        "alter table bundle_events modify column from_bundle_id char(36) null",
        "alter table bundle_events modify column update_strategy text null",
        ...checks,
      ];
    case "postgresql":
    case "cockroachdb":
      return [
        ...oldCheckNames.map(
          (name) => `alter table bundle_events drop constraint ${name}`,
        ),
        "alter table bundle_events alter column from_bundle_id drop not null",
        "alter table bundle_events alter column update_strategy drop not null",
        ...checks,
      ];
    case "mssql":
      return [
        ...oldCheckNames.map(
          (name) => `alter table bundle_events drop constraint ${name}`,
        ),
        `alter table bundle_events alter column from_bundle_id ${getSqlType("uuid", provider)} null`,
        `alter table bundle_events alter column update_strategy ${getSqlType("string", provider)} null`,
        ...checks,
      ];
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
};
