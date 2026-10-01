import {
  createStorageAdapter,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { insights } from "../plugins/insights";
import { serverDefinitionOf } from "./index";

describe("serverDefinitionOf", () => {
  it("reads the database, storage, and plugins a server definition configures", () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };
    // Storage that only uploads, as the CLI's credentials for a managed
    // server allow; the managed runtime serves downloads with its own.
    const uploads = createStorageAdapter({
      name: "uploads",
      protocol: "r2",
      put: async () => ({ storageUri: "r2://bucket/key" }),
    });
    const plugins = [insights()];

    const definition = serverDefinitionOf(
      createHotUpdater({
        database,
        storage: [uploads],
        plugins,
        clientAccess: "public",
      }),
    );

    expect(definition?.database).toBe(database);
    expect(definition?.storage).toEqual([uploads]);
    expect(definition?.plugins).toBe(plugins);
    expect(definition?.target.schema.tables.map(({ name }) => name)).toContain(
      "bundle_events",
    );
  });

  it("reads nothing from a value createHotUpdater did not return", () => {
    expect(serverDefinitionOf({ adapterName: "memory" })).toBeUndefined();
    expect(serverDefinitionOf(null)).toBeUndefined();
  });
});
