import { describe, expect, it, vi } from "vitest";

import {
  assertInfrastructureGenerationAtUrl,
  assertInfrastructureGenerationPayload,
} from "./infrastructureGeneration";
import { InitError, LegacyInfrastructureError } from "./initOptions";

describe("infrastructure generation checks", () => {
  it("accepts the v1 generation marker", () => {
    expect(() =>
      assertInfrastructureGenerationPayload({
        payload: { infrastructureGeneration: 1, version: "1.0.0" },
        provider: "Test",
        resource: "Function update-server",
      }),
    ).not.toThrow();
  });

  it("blocks an existing endpoint without the v1 marker", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      assertInfrastructureGenerationAtUrl({
        fetchImpl,
        provider: "Test",
        resource: "Function update-server",
        versionUrl: "https://updates.example.com/version",
      }),
    ).rejects.toBeInstanceOf(LegacyInfrastructureError);
  });

  it("fails closed when an existing endpoint cannot be checked", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));

    await expect(
      assertInfrastructureGenerationAtUrl({
        fetchImpl,
        provider: "Test",
        resource: "Function update-server",
        versionUrl: "https://updates.example.com/version",
      }),
    ).rejects.toBeInstanceOf(InitError);
  });
});
