import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneCoreApi } from "./standaloneCore";
import { createStandaloneHttp } from "./standaloneHttp";

const SPECIAL_BUNDLE_IDS = [
  { id: "bundle/with-slash", encoded: "bundle%2Fwith-slash" },
  { id: "bundle?with-query", encoded: "bundle%3Fwith-query" },
  { id: "bundle#with-fragment", encoded: "bundle%23with-fragment" },
  { id: "../dot-segment", encoded: "..%2Fdot-segment" },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone admin routes", () => {
  it("normalizes a trailing slash on the admin base URL", () => {
    const http = createStandaloneHttp({
      baseUrl: "https://example.test/hot-updater/admin/",
    });

    expect(http.buildUrl("/bundles")).toBe(
      "https://example.test/hot-updater/admin/bundles",
    );
  });

  it.each([
    ["getBundle", "GET"],
    ["updateBundle", "PATCH"],
  ] as const)("encodes bundle IDs for %s", async (operation, method) => {
    const fetch = vi.fn(async (input: string | URL, _init?: RequestInit) =>
      String(input).endsWith("/version")
        ? Response.json({ adminProtocol: 2 })
        : operation === "getBundle"
          ? new Response(null, { status: 404 })
          : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetch);
    const core = createStandaloneCoreApi({ baseUrl: "https://example.test" });

    for (const { id, encoded } of SPECIAL_BUNDLE_IDS) {
      if (operation === "getBundle") await core.getBundle(id);
      else await core.updateBundle(id, { gitCommitHash: "abc" });

      const [input, init] = (fetch.mock.calls.at(-1) ?? []) as unknown as [
        string | URL,
        RequestInit | undefined,
      ];
      expect(new URL(String(input)).pathname).toBe(`/bundles/${encoded}`);
      expect(init?.method).toBe(method);
    }
  });
});
