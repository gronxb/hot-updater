import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneBundleRemote } from "./standaloneBundleRemote";

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
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash",
  gitCommitHash: null,
  message: "message",
  channel: "production",
  storageUri: "storage://bundle",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone management routes", () => {
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
        expect(String(input)).toBe(
          `https://example.test/api/bundles/${encoded}`,
        );
        expect(init?.method).toBe(method);
      }
    },
  );
});
