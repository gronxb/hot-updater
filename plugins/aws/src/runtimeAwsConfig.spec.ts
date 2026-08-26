import { describe, expect, it, vi } from "vitest";

import { applyKmsRuntimeAwsConfig } from "./runtimeAwsConfig";

describe("applyKmsRuntimeAwsConfig", () => {
  it("isolates KMS signing from ambient AWS endpoint overrides", () => {
    vi.stubEnv("AWS_ENDPOINT_URL", "https://ambient.example.com");

    expect(applyKmsRuntimeAwsConfig({ region: "us-east-1" })).toEqual({
      ignoreConfiguredEndpointUrls: true,
      region: "us-east-1",
    });
  });

  it("preserves an explicit KMS endpoint", () => {
    expect(
      applyKmsRuntimeAwsConfig({
        endpoint: "http://127.0.0.1:4566",
        region: "us-east-1",
      }),
    ).toEqual({
      endpoint: "http://127.0.0.1:4566",
      ignoreConfiguredEndpointUrls: true,
      region: "us-east-1",
    });
  });
});
