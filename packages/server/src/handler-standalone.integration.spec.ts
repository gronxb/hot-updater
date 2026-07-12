import { PGlite } from "@electric-sql/pglite";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { setupDatabaseClientTestSuite } from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { kyselyAdapter } from "./adapters/kysely";
import { createMigrator } from "./db";
import { createHotUpdater } from "./index";

const db = new PGlite();
const kysely = new Kysely({ dialect: new PGliteDialect(db) });
const database = kyselyAdapter({ db: kysely, provider: "postgresql" });
const api = createHotUpdater({
  database,
  basePath: "/hot-updater",
  routes: { updateCheck: true, bundles: true },
});
const baseUrl = "http://localhost:3000";
const server = setupServer(
  http.all(`${baseUrl}/hot-updater/*`, async ({ request }) => {
    const response = await api.handler(request);
    return new HttpResponse(await response.text(), {
      status: response.status,
      headers: response.headers,
    });
  }),
);

beforeAll(async () => {
  const result = await createMigrator(api).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(async () => {
  server.close();
  await kysely.destroy();
  await db.close();
});

const resetDatabase = async (): Promise<void> => {
  await db.exec("DELETE FROM bundle_patches");
  await db.exec("DELETE FROM bundles");
  await db.exec("DELETE FROM channels");
};

beforeEach(resetDatabase);

setupDatabaseClientTestSuite({
  name: "standalone existing-route aggregate client",
  createAdapter: () =>
    standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    }),
  createClient: createDatabaseClient,
  migrate: () => {},
  reset: resetDatabase,
  dispose: () => {},
});

describe("standalone HTTP surface", () => {
  it("preserves the aggregate bundle routes", async () => {
    const response = await fetch(`${baseUrl}/hot-updater/api/bundles?limit=10`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
  });

  it("does not mount a fixed-model database route", async () => {
    const response = await fetch(
      `${baseUrl}/hot-updater/api/database/v2/bundles/findMany`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
  });
});
