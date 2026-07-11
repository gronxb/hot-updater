import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

export interface D1RestDialectConfig {
  readonly accountId: string;
  readonly cloudflareApiToken: string;
  readonly databaseId: string;
}

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getErrorMessages = (body: unknown): string[] => {
  if (!isJsonRecord(body) || !Array.isArray(body.errors)) return [];

  return body.errors.flatMap((error) => {
    if (!isJsonRecord(error) || typeof error.message !== "string") return [];
    return [error.message];
  });
};

const parseResponseBody = (text: string): unknown => {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const toBigInt = (value: unknown): bigint | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return BigInt(Math.trunc(value));
};

const transactionError = () =>
  new Error(
    "Cloudflare D1 REST queries do not support interactive transactions.",
  );

class D1RestParameterTypeError extends TypeError {
  readonly name = "D1RestParameterTypeError";

  constructor(readonly parameterType: string) {
    super(`Cloudflare D1 REST cannot bind parameter type: ${parameterType}.`);
  }
}

class D1RestQueryCompiler extends SqliteQueryCompiler {
  protected appendValue(parameter: unknown): void {
    if (typeof parameter === "string") {
      super.appendValue(parameter);
      return;
    }

    if (typeof parameter === "number") {
      if (!Number.isFinite(parameter)) {
        throw new D1RestParameterTypeError("non-finite number");
      }
      this.append(parameter.toString());
      return;
    }

    if (typeof parameter === "boolean") {
      this.append(parameter ? "true" : "false");
      return;
    }

    if (typeof parameter === "bigint") {
      this.append(parameter.toString());
      return;
    }

    if (parameter === null) {
      this.append("null");
      return;
    }

    throw new D1RestParameterTypeError(typeof parameter);
  }
}

class D1RestConnection implements DatabaseConnection {
  readonly #config: D1RestDialectConfig;

  constructor(config: D1RestDialectConfig) {
    this.#config = config;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { accountId, cloudflareApiToken, databaseId } = this.#config;
    const parameters = compiledQuery.parameters;
    if (
      !parameters.every(
        (parameter): parameter is string => typeof parameter === "string",
      )
    ) {
      throw new D1RestParameterTypeError("compiled non-string");
    }
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        accountId,
      )}/d1/database/${encodeURIComponent(databaseId)}/query`,
      {
        body: JSON.stringify({
          params: [...parameters],
          sql: compiledQuery.sql,
        }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${cloudflareApiToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    const body = parseResponseBody(await response.text());
    const errors = getErrorMessages(body);

    if (!response.ok) {
      const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
      throw new Error(
        `Cloudflare D1 query failed (${response.status})${detail}`,
      );
    }

    if (!isJsonRecord(body) || body.success !== true) {
      const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
      throw new Error(`Cloudflare D1 query was unsuccessful${detail}`);
    }

    const result = Array.isArray(body.result) ? body.result[0] : undefined;
    if (!isJsonRecord(result) || result.success !== true) {
      throw new Error("Cloudflare D1 returned an unsuccessful query result.");
    }

    const rows = result.results ?? [];
    if (!Array.isArray(rows) || !rows.every(isJsonRecord)) {
      throw new Error("Cloudflare D1 returned malformed query rows.");
    }

    const meta = isJsonRecord(result.meta) ? result.meta : {};
    const numAffectedRows = toBigInt(meta.changes);
    const insertId = toBigInt(meta.last_row_id);

    return {
      ...(insertId === undefined ? {} : { insertId }),
      ...(numAffectedRows === undefined ? {} : { numAffectedRows }),
      rows: rows as R[],
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Cloudflare D1 REST queries do not support streaming.");
  }
}

class D1RestDriver implements Driver {
  readonly #connection: DatabaseConnection;

  constructor(config: D1RestDialectConfig) {
    this.#connection = new D1RestConnection(config);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.#connection);
  }

  beginTransaction(): Promise<void> {
    return Promise.reject(transactionError());
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(transactionError());
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(transactionError());
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export class D1RestDialect implements Dialect {
  readonly #config: D1RestDialectConfig;

  constructor(config: D1RestDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new D1RestDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new D1RestQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
