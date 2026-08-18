import { LegacyInfrastructureError } from "@hot-updater/cli-tools";
import { describe, expect, it, vi } from "vitest";

import { assertAwsInfrastructureGeneration } from "./awsInfrastructureState";

describe("assertAwsInfrastructureGeneration", () => {
  it("accepts an existing v1 distribution", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ infrastructureGeneration: 1, version: "1.0.0" }),
          { status: 200 },
        ),
      );

    await expect(
      assertAwsInfrastructureGeneration({
        domainName: "updates.example.com",
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a v0 distribution before it can be updated", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ version: "0.37.0" }), { status: 200 }),
      );

    await expect(
      assertAwsInfrastructureGeneration({
        domainName: "legacy.example.com",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LegacyInfrastructureError);
  });

  it("does not classify an unreachable distribution as v0", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));

    await expect(
      assertAwsInfrastructureGeneration({
        domainName: "updates.example.com",
        fetchImpl,
      }),
    ).rejects.toThrow("Could not verify the AWS infrastructure generation");
  });
});
