import { afterEach, describe, expect, it } from "vitest";

import {
  assertCloudflareNonInteractiveInputs,
  resolveCloudflareInitInputs,
} from "./cloudflareInitInputs";

const processEnvKeys = [
  "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
  "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
] as const;

describe("resolveCloudflareInitInputs", () => {
  afterEach(() => {
    for (const key of processEnvKeys) {
      delete process.env[key];
    }
  });

  it("keeps Cloudflare process environment precedence", () => {
    // Given
    process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID = "process-account";
    process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME = "process-bucket";
    const existingEnv = {
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "saved-account",
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "",
      HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: "saved-bucket",
    };

    // When
    const inputs = resolveCloudflareInitInputs(existingEnv);

    // Then
    expect(inputs.accountId).toBe("process-account");
    expect(inputs.bucketName).toBe("process-bucket");
    expect(inputs.apiToken).toBe("");
  });
});

describe("assertCloudflareNonInteractiveInputs", () => {
  it("reports all missing Cloudflare inputs before deployment", () => {
    // Given
    const inputs = resolveCloudflareInitInputs({
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
      HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: "bucket-name",
    });

    // When
    const assertInputs = () =>
      assertCloudflareNonInteractiveInputs(inputs, true);

    // Then
    expect(assertInputs).toThrow(
      expect.objectContaining({
        missingInputs: [
          "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
          "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
          "HOT_UPDATER_CLOUDFLARE_WORKER_NAME",
          "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
          "HOT_UPDATER_CLOUDFLARE_R2_PRIVATE",
        ],
      }),
    );
  });
});
