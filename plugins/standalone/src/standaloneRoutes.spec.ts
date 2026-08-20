import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneBundleRemote } from "./standaloneBundleRemote";
import { createStandaloneHttp } from "./standaloneHttp";

const SPECIAL_BUNDLE_IDS = [
  {
    id: "bundle/with-slash",
    encoded: "bundle%2Fwith-slash",
  },
  {
    id: "bundle?with-query",
    encoded: "bundle%3Fwith-query",
  },
  {
    id: "bundle#with-fragment",
    encoded: "bundle%23with-fragment",
  },
  {
    id: "../dot-segment",
    encoded: "..%2Fdot-segment",
  },
] as const;

const createBundle = (id: string) => ({
  id,
  platform: "ios" as const,
  fileHash: "hash",
  gitCommitHash: null,
  storageUri: "storage://bundle",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone management routes", () => {
  it("normalizes a trailing slash on the admin base URL", () => {
    const http = createStandaloneHttp({
      baseUrl: "https://example.test/hot-updater/admin/",
    });

    expect(http.buildUrl("/bundles")).toBe(
      "https://example.test/hot-updater/admin/bundles",
    );
  });

  it.each([
    ["retrieve", "GET"],
    ["update", "PATCH"],
    ["delete", "DELETE"],
  ] as const)(
    "encodes bundle IDs for direct %s requests",
    async (operation, method) => {
      const fetch = vi.fn(
        async (_input: string | URL, _init?: RequestInit) =>
          new Response(JSON.stringify(createBundle("response-id")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const remote = createStandaloneBundleRemote({
        baseUrl: "https://example.test",
      });

      for (const { id, encoded } of SPECIAL_BUNDLE_IDS) {
        if (operation === "retrieve") await remote.loadBundle(id);
        if (operation === "update") await remote.updateBundle(createBundle(id));
        if (operation === "delete") await remote.deleteBundle(id);

        const [input, init] = fetch.mock.calls.at(-1) ?? [];
        expect(String(input)).toBe(`https://example.test/bundles/${encoded}`);
        expect(init?.method).toBe(method);
      }
    },
  );
});
