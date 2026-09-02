import { createInsightsReportPageCursor } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import {
  runPrismaInsightsTransaction,
  type PrismaInsightsClient,
} from "./client";
import { createPrismaInsightsModel } from "./model";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000d006";

describe("Prisma Insights transactions", () => {
  it("fails model construction without raw callback transactions", () => {
    expect(() =>
      createPrismaInsightsModel(
        { $transaction: async () => undefined },
        "sqlite",
        insightsDatabaseNamespace,
      ),
    ).toThrow(
      "Prisma Insights requires callback transactions and raw query/execute methods",
    );
  });

  it("retries serialization conflicts and always requests Serializable", async () => {
    const options: unknown[] = [];
    let attempts = 0;
    const client: PrismaInsightsClient = {
      $queryRawUnsafe: async <TResult>() => [] as TResult,
      $executeRawUnsafe: async () => 0,
      $transaction: async <TResult>(
        callback: (transaction: object) => Promise<TResult>,
        transactionOptions: unknown,
      ) => {
        options.push(transactionOptions);
        attempts += 1;
        if (attempts < 3)
          throw Object.assign(new Error("conflict"), { code: "P2034" });
        return callback({
          $queryRawUnsafe: async () => [],
          $executeRawUnsafe: async () => 0,
        });
      },
    };

    await expect(
      runPrismaInsightsTransaction(
        client,
        "cockroachdb",
        async () => "committed",
      ),
    ).resolves.toBe("committed");
    expect(options).toEqual([
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 60_000 },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 60_000 },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 60_000 },
    ]);
  });

  it("does not retry non-serialization failures", async () => {
    let attempts = 0;
    const failure = new Error("failed");
    const client: PrismaInsightsClient = {
      $queryRawUnsafe: async <TResult>() => [] as TResult,
      $executeRawUnsafe: async () => 0,
      $transaction: async <TResult>(
        _callback: (client: object) => Promise<TResult>,
        _options?: { readonly isolationLevel: "Serializable" },
      ): Promise<TResult> => {
        attempts += 1;
        throw failure;
      },
    };

    await expect(
      runPrismaInsightsTransaction(client, "sqlite", async () => undefined),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("rejects search and report cursor scope before any storage statement", async () => {
    let statements = 0;
    let transactions = 0;
    const client: PrismaInsightsClient = {
      $queryRawUnsafe: async <TResult>() => {
        statements += 1;
        return [] as TResult;
      },
      $executeRawUnsafe: async () => {
        statements += 1;
        return 0;
      },
      $transaction: async <TResult>(
        callback: (transaction: object) => Promise<TResult>,
      ) => {
        transactions += 1;
        return callback(client);
      },
    };
    const model = createPrismaInsightsModel(
      client,
      "sqlite",
      insightsDatabaseNamespace,
    );
    const searchCursor = JSON.stringify([
      "prisma-search-sha256-v3",
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      "0".repeat(64),
      "1".repeat(64),
    ]);
    await expect(
      model.pageInstallations({
        kind: "contains",
        query: "different-query",
        limit: 10,
        cursor: searchCursor,
      }),
    ).rejects.toThrow("invalid-query");

    const cursor = createInsightsReportPageCursor(
      {
        publicationId: "publication-a",
        section: "bundleDistribution",
        limit: 10,
      },
      "1",
      "00000000-0000-7000-8000-000000000003",
    );
    await expect(
      model.pageReport({
        publicationId: "publication-b",
        section: "bundleDistribution",
        limit: 10,
        cursor,
      }),
    ).rejects.toThrow("invalid-query");
    expect({ statements, transactions }).toEqual({
      statements: 0,
      transactions: 0,
    });
  });

  it("retries PostgreSQL raw-query serialization failures only", async () => {
    let attempts = 0;
    const client: PrismaInsightsClient = {
      $queryRawUnsafe: async <TResult>() => [] as TResult,
      $executeRawUnsafe: async () => 0,
      $transaction: async <TResult>(
        callback: (transaction: object) => Promise<TResult>,
      ) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("raw query failed"), {
            code: "P2010",
            meta: { code: "40001" },
          });
        }
        return callback({
          $queryRawUnsafe: async () => [],
          $executeRawUnsafe: async () => 0,
        });
      },
    };

    await expect(
      runPrismaInsightsTransaction(client, "postgresql", async () => 2),
    ).resolves.toBe(2);
    expect(attempts).toBe(2);

    attempts = 0;
    await expect(
      runPrismaInsightsTransaction(client, "mysql", async () => 2),
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "40001" } });
    expect(attempts).toBe(1);
  });
});
