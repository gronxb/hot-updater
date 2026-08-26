import { describe, expect, it } from "vitest";

import { getAwsV1SsmParameterName } from "./awsInfrastructureNames";

describe("AWS v1 infrastructure names", () => {
  it("isolates the signing key by generation and Lambda name", () => {
    expect(getAwsV1SsmParameterName("hot-updater-v1-edge")).toBe(
      "/hot-updater/v1/hot-updater-v1-edge/keypair",
    );
  });
});
