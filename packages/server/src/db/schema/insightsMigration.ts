import { bundleEventsV100, bundleInstallationsV100 } from "../../schema/v1_0_0";
import { bundleEventsV101, bundleInstallationsV101 } from "../../schema/v1_0_1";
import type { ORMSQLProvider } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";
import { createIndexSql, getSqlType, sqlColumnDefinition } from "./sql";

export const getInsightsCollationSql = (
  provider: ORMSQLProvider,
): readonly string[] =>
  [bundleEventsV101, bundleInstallationsV101].flatMap((table) =>
    table.columns.flatMap((column) => {
      const collation = column.providerCollations?.[provider];
      if (collation === undefined) return [];
      if (provider === "mysql") {
        return [
          `alter table ${table.ormName} modify column ${sqlColumnDefinition(table, { ...column, primaryKey: undefined }, provider)}`,
        ];
      }
      return [
        `alter table ${table.ormName} alter column ${column.ormName} type ${getSqlType(column.type, provider)} collate ${collation}`,
      ];
    }),
  );

export const getInsightsV101Sql = (
  provider: ORMSQLProvider,
  existingIndexNames: ReadonlySet<string> = new Set(),
): readonly string[] => [
  ...getInsightsCollationSql(provider),
  ...[
    [bundleEventsV100, bundleEventsV101],
    [bundleInstallationsV100, bundleInstallationsV101],
  ].flatMap(([previous, current]) =>
    (current!.indexes ?? [])
      .filter(
        (index) =>
          schemaIndexAppliesToProvider(index, provider) &&
          !previous!.indexes?.some(({ name }) => name === index.name) &&
          !existingIndexNames.has(index.name),
      )
      .map((index) => createIndexSql(current!, index, provider)),
  ),
];
