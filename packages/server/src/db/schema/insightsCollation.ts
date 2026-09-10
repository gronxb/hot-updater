import { bundleEventHeadsV100, bundleEventsV100 } from "../../schema/v1_0_0";
import type { ORMSQLProvider } from "../types";
import { getSqlType, sqlColumnDefinition } from "./sql";

export const getInsightsCollationSql = (
  provider: ORMSQLProvider,
): readonly string[] =>
  [bundleEventsV100, bundleEventHeadsV100].flatMap((table) =>
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
