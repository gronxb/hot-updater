import { PGlite } from "@electric-sql/pglite";
import { setupDatabaseAdapterTestSuite } from "@hot-updater/test-utils";
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

setupDatabaseAdapterTestSuite({
  name: "standalone HTTP database adapter v2",
  createAdapter: () =>
    standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
      getUpdateInfo: true,
    }),
  migrate: () => {},
  reset: resetDatabase,
  dispose: () => {},
  capabilities: { getUpdateInfo: true },
});

const postProtocol = (model: string, operation: string, body: unknown) =>
  fetch(`${baseUrl}/hot-updater/api/database/v2/${model}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("standalone database protocol boundary", () => {
  it("rejects an unknown model", async () => {
    const response = await postProtocol("users", "findMany", {});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unsupported-operation",
        message: "Unsupported database operation: users.findMany.",
      },
    });
  });

  it("rejects an unsupported model and method pair", async () => {
    const response = await postProtocol("channels", "delete", {
      where: [{ field: "id", value: "production" }],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unsupported-operation",
        message: "Unsupported database operation: channels.delete.",
      },
    });
  });

  it("rejects unknown fields and operators", async () => {
    const response = await postProtocol("bundles", "findMany", {
      where: [{ field: "id", operator: "matches", value: ".*" }],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-request" },
    });
  });

  it("exposes the optional fast path without exposing transactions", async () => {
    const response = await postProtocol("bundles", "getUpdateInfo", {
      _updateStrategy: "appVersion",
      platform: "ios",
      bundleId: "00000000-0000-0000-0000-000000000000",
      appVersion: "1.0.0",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: null });

    const transaction = await postProtocol("bundles", "transaction", {});
    expect(transaction.status).toBe(400);
  });

  it("preserves the aggregate bundle routes", async () => {
    const response = await fetch(`${baseUrl}/hot-updater/api/bundles?limit=10`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
  });
});
