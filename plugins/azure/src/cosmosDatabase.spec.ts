import { createHotUpdater } from "@hot-updater/server";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expect, it, vi } from "vitest";

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

  it("reads a connection string from a function on the first request, and names the account by endpoint", async () => {
    const connectionString = vi.fn(async () => {
      throw new Error("secretEnv found no value for COSMOS_CONNECTION_STRING");
    });

    const database = cosmosDatabase({
      endpoint: connection.endpoint,
      connectionString,
    });
    expect(connectionString).not.toHaveBeenCalled();
    expect(
      Reflect.get(database, Symbol.for("@hot-updater/database-target")),
    ).toBe("cosmos/account.documents.azure.com");

    const core = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    }).core;
    await expect(core.listChannels()).rejects.toThrow(
      "secretEnv found no value for COSMOS_CONNECTION_STRING",
    );
    expect(connectionString).toHaveBeenCalled();
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
