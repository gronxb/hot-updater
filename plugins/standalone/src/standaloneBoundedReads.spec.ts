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
