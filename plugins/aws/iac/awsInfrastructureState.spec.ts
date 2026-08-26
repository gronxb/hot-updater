import { LegacyInfrastructureError } from "@hot-updater/cli-tools";
import { describe, expect, it, vi } from "vitest";

import {
  assertAwsInfrastructureGeneration,
  assertAwsLambdaCanInitialize,
  resolveAwsDistributionGeneration,
} from "./awsInfrastructureState";

describe("resolveAwsDistributionGeneration", () => {
  it("recognizes a v1 distribution at the current version path", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/version") &&
      !String(input).includes("/api/check-update/")
        ? new Response(
            JSON.stringify({ infrastructureGeneration: 1, version: "1.0.0" }),
            { status: 200 },
          )
        : new Response(null, { status: 403 }),
    );

    await expect(
      resolveAwsDistributionGeneration({
        domainName: "updates.example.com",
        fetchImpl,
      }),
    ).resolves.toBe("v1");
  });

  it("recognizes a v0 distribution at the legacy AWS base path", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/api/check-update/version")
        ? new Response(JSON.stringify({ version: "0.36.0" }), { status: 200 })
        : new Response(null, { status: 403 }),
    );

    await expect(
      resolveAwsDistributionGeneration({
        domainName: "legacy.example.com",
        fetchImpl,
      }),
    ).resolves.toBe("v0");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://legacy.example.com/api/check-update/version",
    );
  });

  it("does not classify unrelated error responses as v0", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));

    await expect(
      resolveAwsDistributionGeneration({
        domainName: "unknown.example.com",
        fetchImpl,
      }),
    ).resolves.toBe("unknown");
  });
});

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
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://updates.example.com/version",
    );
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

describe("assertAwsLambdaCanInitialize", () => {
  const credentials = {
    accessKeyId: "access-key-id",
    secretAccessKey: "secret-access-key",
  } as const;

  it("allows a new Lambda function name", async () => {
    const lambdaClient = {
      getFunctionConfiguration: vi.fn().mockRejectedValue(
        Object.assign(new Error("not found"), {
          name: "ResourceNotFoundException",
        }),
      ),
      invoke: vi.fn(),
    };

    await expect(
      assertAwsLambdaCanInitialize({
        credentials,
        lambdaClient,
        lambdaName: "hot-updater-edge",
      }),
    ).resolves.toBeUndefined();
    expect(lambdaClient.invoke).not.toHaveBeenCalled();
  });

  it("accepts an existing v1 Lambda function", async () => {
    const lambdaClient = {
      getFunctionConfiguration: vi.fn().mockResolvedValue({}),
      invoke: vi.fn().mockResolvedValue({
        Payload: Buffer.from(
          JSON.stringify({
            body: JSON.stringify({ infrastructureGeneration: 1 }),
            status: "200",
          }),
        ),
      }),
    };

    await expect(
      assertAwsLambdaCanInitialize({
        credentials,
        lambdaClient,
        lambdaName: "hot-updater-edge",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks an existing v0 Lambda function", async () => {
    const lambdaClient = {
      getFunctionConfiguration: vi.fn().mockResolvedValue({}),
      invoke: vi.fn().mockResolvedValue({
        Payload: Buffer.from(
          JSON.stringify({
            body: JSON.stringify({ error: "Not Found" }),
            status: "404",
          }),
        ),
      }),
    };

    await expect(
      assertAwsLambdaCanInitialize({
        credentials,
        lambdaClient,
        lambdaName: "hot-updater-edge",
      }),
    ).rejects.toBeInstanceOf(LegacyInfrastructureError);
  });
});
