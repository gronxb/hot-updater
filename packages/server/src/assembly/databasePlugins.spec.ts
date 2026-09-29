import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { apiKeys } from "../plugins/api-keys";
import { insights } from "../plugins/insights";
import { HotUpdaterConfigError } from "./assemblePlugins";
import {
  createDatabasePluginApis,
  createMeasuredDatabase,
} from "./databasePlugins";

describe("createDatabasePluginApis", () => {
  it("assembles the listed plugins over the database's engine, on the server's tables", async () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };

    const api = createDatabasePluginApis(database, [insights(), apiKeys()]);
    const created = await api.apiKeys.create({ name: "Console" });

    expect(Object.keys(api).sort()).toEqual(["apiKeys", "insights"]);
    // Another assembly over the same database reads the same table.
    await expect(
      createDatabasePluginApis(database, [apiKeys()]).apiKeys.list(),
    ).resolves.toEqual([expect.objectContaining({ id: created.record.id })]);
  });

  it("gives no APIs for an empty plugin list", () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };

    expect(createDatabasePluginApis(database, [])).toEqual({});
  });

  it("refuses a database off the storage engine, and a malformed list", () => {
    expect(() =>
      createDatabasePluginApis({ name: "old", models: {} }, [insights()]),
    ).toThrow("Upgrade its provider package to 1.0.");
    expect(() =>
      createDatabasePluginApis(
        { name: "memory", adapter: createMemoryAdapter() },
        [insights(), insights()],
      ),
    ).toThrow(HotUpdaterConfigError);
  });
});

describe("createMeasuredDatabase", () => {
  it("runs core and the plugins on one engine in verify mode, over the adapter as given", async () => {
    // A bare adapter without settings rows, which the schema fence would refuse.
    const { core, api, clientAuth, measureReads } = createMeasuredDatabase(
      createMemoryAdapter(),
      [insights(), apiKeys()],
    );
    const { apiKey } = await api.apiKeys.create({ name: "Console" });
    await core.ensureChannel("production");

    const measured = await measureReads(async () => ({
      authenticated: await clientAuth!.authenticate(
        new Headers({ "x-api-key": apiKey }),
      ),
      channel: await core.findChannelByName("production"),
    }));

    expect(measured).toEqual({
      result: {
        authenticated: true,
        channel: { id: expect.any(String), name: "production" },
      },
      adapter: { gets: 0, keys: 0, queries: 2, rows: 2 },
      engine: { calls: 2, rows: 2 },
    });
  });
});
