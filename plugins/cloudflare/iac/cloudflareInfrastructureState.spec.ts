import { describe, expect, it, vi } from "vitest";

import {
  assertCloudflareInfrastructureCanInitialize,
  assertCloudflareWorkerCanInitialize,
  resolveCloudflareInfrastructureState,
} from "./cloudflareInfrastructureState";

describe("Cloudflare infrastructure generation", () => {
  it.each([
    [[], "fresh"],
    [["unrelated"], "fresh"],
    [["bundles"], "v0"],
    [["bundles", "release_catalogs"], "v1"],
  ] as const)("classifies %j as %s", (tables, expected) => {
    expect(resolveCloudflareInfrastructureState(tables)).toBe(expected);
  });

  it("blocks a selected v0 D1 database", () => {
    expect(() =>
      assertCloudflareInfrastructureCanInitialize(["bundles"], "legacy-db"),
    ).toThrow(
      "Cloudflare v0 infrastructure was detected at D1 database legacy-db",
    );
  });

  it("allows a Worker name that does not exist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      assertCloudflareWorkerCanInitialize({
        fetchImpl,
        scriptNames: ["another-worker"],
        workerName: "hot-updater",
        workersSubdomain: "example",
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 404])(
    "blocks an existing v0 Worker returning HTTP %i with the selected name",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));

      await expect(
        assertCloudflareWorkerCanInitialize({
          fetchImpl,
          scriptNames: ["hot-updater"],
          workerName: "hot-updater",
          workersSubdomain: "example",
        }),
      ).rejects.toThrow(
        "Cloudflare v0 infrastructure was detected at Worker hot-updater",
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://hot-updater.example.workers.dev/version",
      );
    },
  );

  it("allows an existing v1 Worker with the selected name", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ infrastructureGeneration: 1, version: "1.0.0" }),
      );

    await expect(
      assertCloudflareWorkerCanInitialize({
        fetchImpl,
        scriptNames: ["hot-updater"],
        workerName: "hot-updater",
        workersSubdomain: "example",
      }),
    ).resolves.toBeUndefined();
  });
});
