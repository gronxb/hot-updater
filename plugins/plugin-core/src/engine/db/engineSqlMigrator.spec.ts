import { conformanceItems } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { SETTINGS_TABLE } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor, SqlStatement } from "../database/sql/sqlAdapter";
import { sqlTableShapes, type SqlTableShape } from "../database/sql/sqlSchema";
import { createEngineSqlMigrator } from "./engineSqlMigrator";

const schema = {
  models: new Map(),
  tables: [conformanceItems],
} as unknown as ResolvedSchema;

/** Every table's declared indexes, by table name, index tables included. */
const declared = (shapes: readonly SqlTableShape[]): [string, string][] =>
  shapes.flatMap((shape) =>
    shape.indexes.flatMap((index) =>
      index.kind === "table"
        ? declared([index.table])
        : [[shape.name, index.name] as [string, string]],
    ),
  );

describe("createEngineSqlMigrator on MySQL", () => {
  it("finds a table's indexes under the lower-case names lower_case_table_names=1 reports", async () => {
    const statements: SqlStatement[] = [];
    // A server with lower_case_table_names=1: information_schema names
    // `conformance_items__byTag` in lower case, its indexes all present.
    const existing = declared(
      sqlTableShapes("mysql", [conformanceItems, SETTINGS_TABLE]),
    ).map(([t, i]) => ({ t: t.toLowerCase(), i }));
    const execute = async (statement: SqlStatement) => {
      statements.push(statement);
      if (statement.sql.includes("information_schema.statistics")) {
        return { rows: existing, changes: 0 };
      }
      return { rows: [], changes: 0 };
    };
    const executor: SqlExecutor = {
      dialect: "mysql",
      execute,
      transaction: (fn) => fn({ execute }),
    };
    const migrator = createEngineSqlMigrator({
      adapterName: "test",
      executor,
      schema,
      settings: { "schema.core": "1.2.0" },
    });
    await (await migrator.up()).execute();

    expect(
      statements.filter(({ sql }) => /^CREATE (UNIQUE )?INDEX/u.test(sql)),
    ).toEqual([]);
  });
});
