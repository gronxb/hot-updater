import { describe, expect, it } from "vitest";

import { cosmosDatabase } from "./cosmosDatabase";

const connection = {
  endpoint: "https://account.documents.azure.com:443/",
  key: "dGVzdA==",
};

describe("cosmosDatabase", () => {
  it("creates its client on the first request, so a config loads without the connection", async () => {
    const database = cosmosDatabase({ connectionString: undefined as never });
    await database.dispose?.();
  });

  it("refuses a client consistency weaker than the strong reads it plans writes from", () => {
    expect(() =>
      cosmosDatabase({
        ...connection,
        consistencyLevel: "Session" as "Strong",
      }),
    ).toThrow('consistencyLevel "Session" is weaker');
  });

  it("takes the account's consistency or an explicit Strong", async () => {
    for (const consistencyLevel of [undefined, "Strong"] as const) {
      const database = cosmosDatabase({ ...connection, consistencyLevel });
      await database.dispose?.();
    }
  });
});
