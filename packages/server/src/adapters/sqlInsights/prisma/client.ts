import { setTimeout as delay } from "node:timers/promises";

import type { ORMSQLProvider } from "../../../db/types";

export interface PrismaInsightsRawClient {
  $executeRawUnsafe(
    query: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRawUnsafe<TResult = unknown>(
    query: string,
    ...values: readonly unknown[]
  ): Promise<TResult>;
}

export interface PrismaInsightsClient extends PrismaInsightsRawClient {
  $transaction<TResult>(
    callback: (client: object) => Promise<TResult>,
    options?: {
      readonly isolationLevel: "Serializable";
      readonly maxWait?: number;
      readonly timeout?: number;
    },
  ): Promise<TResult>;
}

export class PrismaInsightsConfigurationError extends Error {
  readonly name = "PrismaInsightsConfigurationError";
}

const hasFunction = (value: object, key: string): boolean =>
  key in value && typeof Reflect.get(value, key) === "function";

export function assertPrismaInsightsClient(
  client: object,
): asserts client is PrismaInsightsClient {
  if (
    !hasFunction(client, "$transaction") ||
    !hasFunction(client, "$queryRawUnsafe") ||
    !hasFunction(client, "$executeRawUnsafe")
  ) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights requires callback transactions and raw query/execute methods",
    );
  }
}

export function assertPrismaInsightsRawClient(
  client: object,
): asserts client is PrismaInsightsRawClient {
  if (
    !hasFunction(client, "$queryRawUnsafe") ||
    !hasFunction(client, "$executeRawUnsafe")
  ) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights transaction client is missing raw query/execute methods",
    );
  }
}

export interface PrismaInsightsStatement {
  readonly query: string;
  readonly values: readonly unknown[];
}

export class PrismaInsightsSql {
  readonly #values: unknown[] = [];

  constructor(readonly provider: ORMSQLProvider) {}

  value(value: unknown): string {
    this.#values.push(value);
    switch (this.provider) {
      case "postgresql":
      case "cockroachdb":
        return `$${this.#values.length}`;
      case "mssql":
        return `@P${this.#values.length}`;
      case "mysql":
      case "sqlite":
        return "?";
    }
  }

  statement(query: string): PrismaInsightsStatement {
    return { query, values: this.#values };
  }
}

export const queryPrismaInsights = <TResult>(
  client: PrismaInsightsRawClient,
  statement: PrismaInsightsStatement,
): Promise<TResult> =>
  client.$queryRawUnsafe<TResult>(statement.query, ...statement.values);

export const executePrismaInsights = (
  client: PrismaInsightsRawClient,
  statement: PrismaInsightsStatement,
): Promise<number> =>
  client.$executeRawUnsafe(statement.query, ...statement.values);

export const runPrismaInsightsTransaction = async <TResult>(
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  callback: (client: PrismaInsightsRawClient & object) => Promise<TResult>,
): Promise<TResult> => {
  const attempts =
    provider === "postgresql" || provider === "cockroachdb" ? 12 : 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.$transaction(
        async (transactionClient) => {
          assertPrismaInsightsRawClient(transactionClient);
          return callback(transactionClient);
        },
        {
          isolationLevel: "Serializable",
          maxWait: 10_000,
          timeout: 60_000,
        },
      );
    } catch (error) {
      const rawSerializationFailure =
        (provider === "postgresql" || provider === "cockroachdb") &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2010" &&
        "meta" in error &&
        typeof error.meta === "object" &&
        error.meta !== null &&
        "code" in error.meta &&
        error.meta.code === "40001";
      if (
        attempt >= attempts - 1 ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error.code !== "P2034" && !rawSerializationFailure)
      ) {
        throw error;
      }
      const backoffMs = Math.min(200, 5 * 2 ** attempt);
      const jitterMs = Math.floor(Math.random() * Math.min(21, backoffMs + 1));
      await delay(backoffMs + jitterMs);
    }
  }
};
