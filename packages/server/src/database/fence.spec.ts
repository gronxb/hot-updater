import { PGlite } from "@electric-sql/pglite";
import {
  createEngineDatabase,
  createSqlAdapter,
  migrateCoreSchema,
} from "@hot-updater/plugin-core";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { pgliteExecutor } from "@hot-updater/test-utils/node";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../index";

describe("a provider's fenced database on PGlite", () => {
  const pglite = new PGlite();
  afterAll(() => pglite.close());

  it("answers 503 before migrations and serves after them", async () => {
    const adapter = createSqlAdapter({
      executor: pgliteExecutor(pglite),
      tablePrefix: "fence_",
    });
    const hotUpdater = createHotUpdater({
      database: createEngineDatabase({ name: "pglite", adapter }),
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const channels = () =>
      hotUpdater.handlers.admin(
        new Request("https://updates.example.com/channels"),
      );

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await channels()).status).toBe(503);
    error.mockRestore();
    await migrateCoreSchema(adapter, "pglite");
    expect((await channels()).status).toBe(200);
    await expect(hotUpdater.core.listChannels()).resolves.toEqual([]);
  });
});
