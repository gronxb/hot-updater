import { describe, expect, it } from "vitest";

import type { ORMSQLProvider } from "../../../db/types";
import type { PrismaInsightsRawClient } from "./client";
import {
  insertPrismaInsightsIgnore,
  selectPrismaInsightsRows,
} from "./rawStore";

const providers: readonly ORMSQLProvider[] = [
  "sqlite",
  "cockroachdb",
  "mysql",
  "postgresql",
  "mssql",
];

const recorder = () => {
  const calls: { query: string; values: readonly unknown[] }[] = [];
  const client: PrismaInsightsRawClient = {
    $queryRawUnsafe: async <TResult>(
      query: string,
      ...values: readonly unknown[]
    ) => {
      calls.push({ query, values });
      return [] as TResult;
    },
    $executeRawUnsafe: async (query, ...values) => {
      calls.push({ query, values });
      return 1;
    },
  };
  return { calls, client };
};

describe("Prisma Insights dialect statements", () => {
  it.each(providers)(
    "keeps %s keyset filters before LIMIT in both SQL and bind order",
    async (provider) => {
      const { calls, client } = recorder();
      await selectPrismaInsightsRows(client, provider, {
        table: "private_test",
        columns: ["id"],
        where: { id: { operator: "gt", value: "bound-value" } },
        orderBy: [{ column: "id", direction: "asc" }],
        limit: 7,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.query).not.toContain("bound-value");
      expect(calls[0]!.values).toEqual(["bound-value", 7]);
      if (provider === "mssql") {
        expect(calls[0]!.query).toContain("top (@P2)");
        expect(calls[0]!.query).toContain("id > @P1");
      } else if (provider === "postgresql" || provider === "cockroachdb") {
        expect(calls[0]!.query).toContain("id > $1");
        expect(calls[0]!.query).toContain("limit $2");
      } else {
        expect(calls[0]!.query).toContain("id > ?");
        expect(calls[0]!.query).toContain("limit ?");
      }
    },
  );

  it.each(providers)(
    "binds %s insert values without interpolation",
    async (provider) => {
      const { calls, client } = recorder();
      await insertPrismaInsightsIgnore(
        client,
        provider,
        "private_test",
        { id: "$(not-a-command)", value: "'quoted'" },
        ["id"],
      );

      for (const call of calls) {
        expect(call.query).not.toContain("not-a-command");
        expect(call.query).not.toContain("quoted");
      }
      if (provider === "mysql") {
        expect(calls).toHaveLength(2);
        expect(calls[0]!.query).toContain("limit 1 for update");
        expect(calls[0]!.values).toEqual(["$(not-a-command)"]);
        expect(calls[1]!.values).toEqual(["$(not-a-command)", "'quoted'"]);
      } else {
        expect(calls).toHaveLength(1);
        expect(calls[0]!.values).toEqual(
          provider === "mssql"
            ? ["$(not-a-command)", "$(not-a-command)", "'quoted'"]
            : ["$(not-a-command)", "'quoted'"],
        );
      }
    },
  );
});
