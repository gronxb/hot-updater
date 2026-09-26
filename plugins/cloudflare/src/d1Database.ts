import {
  builtInSettings,
  builtInTarget,
  type SqlStatement,
} from "@hot-updater/server/database";
import type { SchemaGenerator, ToolingDatabase } from "@hot-updater/server/db";
import Cloudflare from "cloudflare";

import {
  createD1Database,
  D1ExecutionError,
  type D1ResultLike,
  toSqlResult,
} from "./d1Executor";
import { d1SchemaSql } from "./d1Schema";

export { D1ExecutionError } from "./d1Executor";

export interface D1DatabaseConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

/** The REST API binds text: each value goes as JSON and is read back with `json_extract`. */
const encode = ({ sql, params }: SqlStatement) => ({
  // A function, since `$'` in a replacement string means "the rest of the input".
  sql: sql.replaceAll("?", () => "json_extract(?, '$')"),
  params: params.map((value) => JSON.stringify(value ?? null)),
});

/**
 * Hot Updater's database on D1 through the Cloudflare REST API, for the CLI
 * and console. `hot-updater db generate` writes a D1 migration of the built-in
 * tables and the server's plugin tables to `migrations`, and
 * `hot-updater db migrate` applies them through the API.
 */
export const d1Database = (config: D1DatabaseConfig): ToolingDatabase => {
  const cloudflare = new Cloudflare({
    apiToken: config.cloudflareApiToken,
  });
  const execute = async (statements: readonly SqlStatement[]) => {
    const [first] = statements;
    if (first === undefined) return [];
    const body =
      statements.length === 1
        ? { account_id: config.accountId, ...encode(first) }
        : { account_id: config.accountId, batch: statements.map(encode) };
    // cloudflare@4 predates the D1 REST API's parameterized batch body type.
    const page = await cloudflare.d1.database.query(
      config.databaseId,
      body as unknown as Parameters<typeof cloudflare.d1.database.query>[1],
    );
    const results = [];
    for await (const resultPage of page.iterPages()) {
      for (const result of resultPage.result) {
        results.push(toSqlResult(result as D1ResultLike));
      }
    }
    if (results.length !== statements.length) throw new D1ExecutionError();
    return results;
  };
  return {
    ...createD1Database({
      query: async (statement) => (await execute([statement]))[0]!,
      batch: execute,
    }),
    generateSchema: ((version, _name, target = builtInTarget) => {
      if (version !== "latest" && version !== builtInSettings["schema.core"]) {
        throw new Error(`Invalid version ${version}`);
      }
      // Wrangler applies migrations in the order of their leading numbers.
      const timestamp = new Date()
        .toISOString()
        .replace(/\D/g, "")
        .slice(0, 14);
      return {
        code: d1SchemaSql(target),
        path: `migrations/${timestamp}_hot-updater.sql`,
      };
    }) satisfies SchemaGenerator,
  };
};
