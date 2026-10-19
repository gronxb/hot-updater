import type { SqlResult, SqlStatement } from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";

import { D1ExecutionError, type D1ResultLike, toSqlResult } from "./d1Executor";

export interface D1RestConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

/**
 * The D1 database a `d1Database` reaches, which the provider's `./init`
 * reads to migrate the database hot-updater.config.ts names. A registered
 * symbol, so the init's own copy of this module reads the config's.
 */
const D1_TARGET = Symbol.for("@hot-updater/cloudflare/d1-target");

/** `database` with the D1 database it reaches, as `d1Database` marks it. */
export const withD1Target = <T extends object>(
  database: T,
  config: D1RestConfig,
) => Object.defineProperty(database, D1_TARGET, { value: config }) as T;

/** The D1 database `database` reaches; undefined unless `d1Database` made it. */
export const d1TargetOf = (database: unknown): D1RestConfig | undefined =>
  typeof database === "object" && database !== null
    ? (Reflect.get(database, D1_TARGET) as D1RestConfig | undefined)
    : undefined;

/** The REST API binds text: each value goes as JSON and is read back with `json_extract`. */
const encode = ({ sql, params }: SqlStatement) => ({
  // A function, since `$'` in a replacement string means "the rest of the input".
  sql: sql.replaceAll("?", () => "json_extract(?, '$')"),
  params: params.map((value) => JSON.stringify(value ?? null)),
});

/**
 * Statements on a D1 database through the Cloudflare REST API: one at a
 * time, or a batch D1 runs in one transaction.
 */
export const d1RestRunner = (config: D1RestConfig) => {
  const cloudflare = new Cloudflare({
    apiToken: config.cloudflareApiToken,
  });
  const batch = async (
    statements: readonly SqlStatement[],
  ): Promise<SqlResult[]> => {
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
    query: async (statement: SqlStatement) => (await batch([statement]))[0]!,
    batch,
  };
};
