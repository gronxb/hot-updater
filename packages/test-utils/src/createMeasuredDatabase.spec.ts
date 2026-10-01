import { createMemoryAdapter, definePlugin } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { describe, expect, it } from "vitest";

import { createMeasuredDatabase } from "./createMeasuredDatabase";

describe("createMeasuredDatabase", () => {
  it("measures core and the plugins on createHotUpdater, over the adapter as given", async () => {
    // A bare adapter without settings rows, which the schema fence would refuse.
    const { core, api, clientAuth, measureReads } =
      await createMeasuredDatabase(createMemoryAdapter(), [
        insights(),
        apiKeys(),
      ]);
    const { apiKey } = await api.apiKeys.create({ name: "Console" });
    await core.ensureChannel("production");

    const measured = await measureReads(async () => ({
      authenticated: await clientAuth!.authenticate(
        new Headers({ "x-api-key": apiKey }),
      ),
      channel: await core.findChannelByName("production"),
    }));

    // What server's own createMeasuredDatabase measured, in verify mode.
    expect(measured).toEqual({
      result: {
        authenticated: true,
        channel: { id: expect.any(String), name: "production" },
      },
      adapter: { gets: 0, keys: 0, queries: 2, rows: 2 },
      engine: { calls: 2, rows: 2 },
    });
  });

  it("gives the plugins its clock", async () => {
    const clock = definePlugin({
      id: "clock",
      schemaVersion: "1",
      schema: {},
      init: ({ now }) => ({ api: { now } }),
    });

    const { api } = await createMeasuredDatabase(
      createMemoryAdapter(),
      [clock],
      { now: () => Date.UTC(2026, 0, 1) },
    );

    expect(api.clock.now()).toBe(Date.UTC(2026, 0, 1));
  });

  it("leaves a server on a database without meterReads unmetered", () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };
    const hotUpdater = createHotUpdater({ database, clientAccess: "public" });

    expect("measureReads" in database).toBe(false);
    expect("measureReads" in hotUpdater).toBe(false);
  });
});
