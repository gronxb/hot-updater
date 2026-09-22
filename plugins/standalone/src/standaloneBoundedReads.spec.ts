import { afterEach, describe, expect, it, vi } from "vitest";

import { standaloneRepository } from "./standaloneRepository";

afterEach(() => vi.unstubAllGlobals());

describe("standalone bounded reads", () => {
  it("hydrates only the distinct requested patch owners without listing history", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetch);
    const repository = standaloneRepository({
      baseUrl: "https://example.test",
    });
    await expect(
      repository.models.bundlePatches.findByBundleIds(["missing", "missing"]),
    ).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://example.test/bundles/missing",
    );
  });

  it("counts through the configured count route without loading a bundle", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ data: { count: 150 } }),
    );
    vi.stubGlobal("fetch", fetch);
    const repository = standaloneRepository({
      baseUrl: "https://example.test",
      commonHeaders: { Authorization: "Bearer test" },
      routes: {
        count: () => ({
          path: "/custom/count",
          headers: { "X-Count": "true" },
        }),
      },
    });
    await expect(
      repository.models.bundles.count({
        platform: "ios",
        id: { in: ["a", "b"] },
      }),
    ).resolves.toBe(150);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [requested, init] = fetch.mock.calls[0]!;
    const input = new URL(String(requested));
    expect(input.pathname).toBe("/custom/count");
    expect(input.searchParams.getAll("idIn")).toEqual(["a", "b"]);
    expect(input.searchParams.get("platform")).toBe("ios");
    expect(input.searchParams.has("limit")).toBe(false);
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test",
      "X-Count": "true",
    });
  });

  it.each([404, 501])(
    "does not substitute a bundle list when count is unavailable (%s)",
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal("fetch", fetch);
      await expect(
        standaloneRepository({
          baseUrl: "https://example.test",
        }).models.bundles.count(),
      ).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "150", null])(
    "rejects invalid count values (%s)",
    async (count) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ data: { count } })),
      );
      await expect(
        standaloneRepository({
          baseUrl: "https://example.test",
        }).models.bundles.count(),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("rejects an unsupported filter before any HTTP request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const repository = standaloneRepository({
      baseUrl: "https://example.test",
    });
    await expect(
      repository.models.bundles.findMany({
        // @ts-expect-error Runtime input from an older or untyped caller.
        where: { file_hash: "hash" },
        limit: 1,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not broaden an empty ID set or a zero limit to a list request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const repository = standaloneRepository({
      baseUrl: "https://example.test",
    });
    await expect(
      repository.models.bundles.count({ id: { in: [] } }),
    ).resolves.toBe(0);
    await expect(
      repository.models.bundles.findMany({
        limit: 0,
        offset: 0,
        orderBy: { field: "id", direction: "desc" },
      }),
    ).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
