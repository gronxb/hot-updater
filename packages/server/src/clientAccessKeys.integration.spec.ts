import { NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { registerClientAccessKey } from "./clientAccessKeys";
import { CLIENT_ACCESS_KEY_HEADER_NAME, createHotUpdater } from "./index";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const updateUrl =
  "https://example.com/api/app-version/ios/1.0.0/production/" +
  `${NIL_UUID}/${NIL_UUID}`;

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
        features: {
          clientAccessKeys: "yes" as unknown as boolean,
        },
      }),
    ).toThrow("Client access-keys option must be a boolean.");
  });

  it("protects only client OTA and Analytics write routes", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerClientAccessKey({
      apiKey: API_KEY,
      clientAccessKeys: database.clientAccessKeys,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      database,
      features: { analytics: true, clientAccessKeys: true },
    });

    expect((await hotUpdater.handler(new Request(updateUrl))).status).toBe(401);
    expect((await hotUpdater.handler(withApiKey(updateUrl))).status).toBe(200);
    expect(
      (await hotUpdater.handler(new Request("https://example.com/api/version")))
        .status,
    ).toBe(200);
    expect(
      (
        await hotUpdater.handler(
          withApiKey("https://example.com/api/installations/overview"),
        )
      ).status,
    ).toBe(401);
  });

  it("authenticates before parsing Analytics event bodies", async () => {
    const database = createInMemoryDatabasePlugin();
    await registerClientAccessKey({
      apiKey: API_KEY,
      clientAccessKeys: database.clientAccessKeys,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      database,
      features: {
        analytics: { queryAccess: "public" },
        clientAccessKeys: true,
      },
    });
    const invalidBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    } satisfies RequestInit;

    expect(
      (
        await hotUpdater.handler(
          new Request("https://example.com/api/events", invalidBody),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await hotUpdater.handler(
          withApiKey("https://example.com/api/events", invalidBody),
        )
      ).status,
    ).toBe(400);
  });

  it("returns 503 when credential storage is unavailable", async () => {
    const database = createInMemoryDatabasePlugin();
    vi.spyOn(database.clientAccessKeys, "findByHash").mockRejectedValue(
      new Error("database offline"),
    );
    const hotUpdater = createHotUpdater({
      database,
      features: { clientAccessKeys: true },
    });

    const response = await hotUpdater.handler(withApiKey(updateUrl));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Service unavailable",
    });
  });

  it("keeps client routes public unless access keys are enabled", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
    });

    expect((await hotUpdater.handler(new Request(updateUrl))).status).toBe(200);
  });
});
