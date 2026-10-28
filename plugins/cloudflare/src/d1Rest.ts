import type { SqlResult, SqlStatement } from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";

import { D1ExecutionError, type D1ResultLike, toSqlResult } from "./d1Executor";

export interface D1RestConfig {
  readonly databaseId: string;
  readonly accountId: string;
  /**
   * An API token with D1 edit permission, or a function that returns it,
   * such as one that reads it with `secretEnv`: called on the first query,
   * so a config loads without the token.
   */
  readonly cloudflareApiToken: string | (() => string | Promise<string>);
}

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
  const { cloudflareApiToken } = config;
  let client: Promise<Cloudflare> | undefined;
  const connect = () =>
    (client ??= (async () =>
      new Cloudflare({
        apiToken:
          typeof cloudflareApiToken === "function"
            ? await cloudflareApiToken()
            : cloudflareApiToken,
      }))().catch((error: unknown) => {
      client = undefined;
      throw error;
    }));
  const batch = async (
    statements: readonly SqlStatement[],
  ): Promise<SqlResult[]> => {
    const [first] = statements;
    if (first === undefined) return [];
    const body =
      statements.length === 1
        ? { account_id: config.accountId, ...encode(first) }
        : { account_id: config.accountId, batch: statements.map(encode) };
    const cloudflare = await connect();
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
