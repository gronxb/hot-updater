import { describe, expect, it } from "vitest";

import { API_KEY_HEADER_NAME, createHotUpdater } from "./index";
import { apiKeys } from "./plugins/api-keys";
import { insights } from "./plugins/insights";
import { createRuntimeDatabase } from "./runtime.testFixtures";

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

/** A server whose client routes the apiKeys() plugin protects, with one registered key. */
const start = async () => {
  const hotUpdater = createHotUpdater({
    database: createRuntimeDatabase(),
    plugins: [apiKeys(), insights()],
  });
  await hotUpdater.api.apiKeys.register({ apiKey: API_KEY, name: "App" });
  return hotUpdater;
};

describe("createHotUpdater with the apiKeys() plugin", () => {
  it("protects only client OTA and Insights write routes", async () => {
    const hotUpdater = await start();

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
          new Request("https://example.com/events"),
        )
      ).status,
    ).toBe(200);
  });

  it("authenticates before parsing Insights event bodies", async () => {
    const hotUpdater = await start();
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

  it('keeps client routes public with clientAccess: "public"', async () => {
    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: createRuntimeDatabase(),
    });

    expect(
      (await hotUpdater.handlers.client(new Request(updateUrl))).status,
    ).toBe(404);
  });
});
