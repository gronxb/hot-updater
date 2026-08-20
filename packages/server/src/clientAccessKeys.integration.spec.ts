import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { registerClientAccessKey } from "./clientAccessKeys";
import { CLIENT_ACCESS_KEY_HEADER_NAME, createHotUpdater } from "./index";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const updateUrl =
  "https://example.com/release-catalogs/app-version/default/ios/" +
  "cHJvZHVjdGlvbg/1.0.0";

const withApiKey = (url: string, init?: RequestInit) =>
  new Request(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      [CLIENT_ACCESS_KEY_HEADER_NAME]: API_KEY,
    },
  });

describe("createHotUpdater client access keys", () => {
  it("rejects invalid client access-key configuration", () => {
    expect(() =>
      createHotUpdater({
        database: createInMemoryDatabasePlugin(),
        clientAccessKeys: "yes" as unknown as boolean,
      }),
    ).toThrow("clientAccessKeys must be a boolean.");
  });

  it("protects only client OTA and Analytics write routes", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerClientAccessKey({
      apiKey: API_KEY,
      clientAccessKeys: database.models.clientAccessKeys,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      database,
      analytics: true,
      clientAccessKeys: true,
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

  it("authenticates before parsing Analytics event bodies", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerClientAccessKey({
      apiKey: API_KEY,
      clientAccessKeys: database.models.clientAccessKeys,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      database,
      analytics: true,
      clientAccessKeys: true,
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
    vi.spyOn(database.models.clientAccessKeys, "findByHash").mockRejectedValue(
      new Error("database offline"),
    );
    const hotUpdater = createHotUpdater({
      database,
      clientAccessKeys: true,
    });

    const response = await hotUpdater.handlers.client(withApiKey(updateUrl));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Service unavailable",
    });
  });

  it.each([undefined, false])(
    "keeps client routes public when the access-key feature is %s",
    async (clientAccessKeys) => {
      const hotUpdater = createHotUpdater({
        database: createInMemoryDatabasePlugin(),
        ...(clientAccessKeys === undefined ? {} : { clientAccessKeys }),
      });

      expect(
        (await hotUpdater.handlers.client(new Request(updateUrl))).status,
      ).toBe(404);
    },
  );
});
