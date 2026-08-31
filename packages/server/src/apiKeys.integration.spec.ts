import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { registerApiKey } from "./apiKeys";
import { API_KEY_HEADER_NAME, createHotUpdater } from "./index";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const updateUrl =
  "https://example.com/release-catalogs/app-version/ios/" +
  "cHJvZHVjdGlvbg/1.0.0";

const withApiKey = (url: string, init?: RequestInit) =>
  new Request(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      [API_KEY_HEADER_NAME]: API_KEY,
    },
  });

describe("createHotUpdater API keys", () => {
  it("rejects an invalid API key header name", () => {
    expect(() =>
      createHotUpdater({
        clientAccess: {
          headerName: "invalid header",
          type: "api-key",
        },
        database: createInMemoryDatabasePlugin(),
      }),
    ).toThrow("clientAccess.headerName must be a valid header name.");
  });

  it("protects only client OTA and Insights write routes", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      clientAccess: { type: "api-key" },
      database,
    });

    expect(
      (await hotUpdater.handlers.client(new Request(updateUrl))).status,
    ).toBe(401);
    expect(
      (await hotUpdater.handlers.client(withApiKey(updateUrl))).status,
    ).toBe(404);
    expect(
      (
        await hotUpdater.handlers.client(
          new Request("https://example.com/version"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await hotUpdater.handlers.admin(
          withApiKey("https://example.com/installations/overview"),
        )
      ).status,
    ).toBe(200);
  });

  it("creates, lists, and revokes API keys without exposing hashes", async () => {
    const hotUpdater = createHotUpdater({
      clientAccess: { type: "public" },
      database: createInMemoryDatabasePlugin(),
    });

    const created = await hotUpdater.apiKeys.create({ name: "Production" });
    expect(created.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.record).not.toHaveProperty("hash");

    await expect(hotUpdater.apiKeys.list()).resolves.toEqual([created.record]);
    const revoked = await hotUpdater.apiKeys.revoke({
      id: created.record.id,
    });
    expect(revoked).toMatchObject({
      id: created.record.id,
      revoked_at_ms: expect.any(Number),
    });
    expect(revoked).not.toHaveProperty("hash");
  });

  it("authenticates before parsing Insights event bodies", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      clientAccess: { type: "api-key" },
      database,
    });
    const invalidBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    } satisfies RequestInit;

    expect(
      (
        await hotUpdater.handlers.client(
          new Request("https://example.com/events", invalidBody),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await hotUpdater.handlers.client(
          withApiKey("https://example.com/events", invalidBody),
        )
      ).status,
    ).toBe(400);
  });

  it("returns 503 when credential storage is unavailable", async () => {
    const database = createInMemoryDatabasePlugin();
    vi.spyOn(database.models.apiKeys, "findByHash").mockRejectedValue(
      new Error("database offline"),
    );
    const hotUpdater = createHotUpdater({
      clientAccess: { type: "api-key" },
      database,
    });

    const response = await hotUpdater.handlers.client(withApiKey(updateUrl));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Service unavailable",
    });
  });

  it("keeps client routes public with the public access policy", async () => {
    const hotUpdater = createHotUpdater({
      clientAccess: { type: "public" },
      database: createInMemoryDatabasePlugin(),
    });

    expect(
      (await hotUpdater.handlers.client(new Request(updateUrl))).status,
    ).toBe(404);
  });

  it("reads API keys only from the configured header", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      clientAccess: {
        headerName: "X-Hot-Updater-Key",
        type: "api-key",
      },
      database,
    });
    const invalidBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    } satisfies RequestInit;

    expect(
      (
        await hotUpdater.handlers.client(
          withApiKey("https://example.com/events", invalidBody),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await hotUpdater.handlers.client(
          new Request("https://example.com/events", {
            ...invalidBody,
            headers: {
              ...invalidBody.headers,
              "x-hot-updater-key": API_KEY,
            },
          }),
        )
      ).status,
    ).toBe(400);
  });
});
