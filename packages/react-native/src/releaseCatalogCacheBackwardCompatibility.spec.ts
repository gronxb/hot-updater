import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { expect, it, vi } from "vitest";

vi.mock("./specs/NativeHotUpdater", () => ({ default: {} }));

import { fetchReleaseCatalogWithCache } from "./releaseCatalogCache";

it("fetches 200 responses without caching on older native binaries", async () => {
  const authorityId = "project-a";
  const scopeKey = createReleaseCatalogScopeKey({
    authorityId,
    channelKey: encodeChannelKey("production"),
    platform: "ios",
    strategy: "APP_VERSION",
  });
  const catalog: ReleaseCatalog = {
    authorityId,
    catalogHash: `sha256:${"a".repeat(64)}`,
    fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
    generation: 1,
    releases: [],
    schemaVersion: 1,
    scopeKey,
  };
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(catalog), {
        headers: { ETag: '"v1"' },
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const input = {
    authorityId,
    baseURL: "https://updates.example.com",
    requestHeaders: { "x-api-key": "key" },
    scopeKey,
    url: "https://updates.example.com/catalog",
  };

  await expect(fetchReleaseCatalogWithCache(input)).resolves.toEqual(catalog);
  await expect(fetchReleaseCatalogWithCache(input)).resolves.toEqual(catalog);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [, request] of fetchMock.mock.calls) {
    expect(
      new Headers((request as RequestInit).headers).has("if-none-match"),
    ).toBe(false);
  }
});
