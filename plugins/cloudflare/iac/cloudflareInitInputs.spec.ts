import { afterEach, describe, expect, it } from "vitest";

import {
  assertCloudflareNonInteractiveInputs,
  resolveR2Privacy,
  resolveCloudflareInitInputs,
  shouldUpdateR2ManagedDomain,
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
    expect(inputs.apiToken).toBeUndefined();
  });
});

describe("shouldUpdateR2ManagedDomain", () => {
  it.each([
    { isPrivate: false, managedDomainEnabled: false, expected: true },
    { isPrivate: true, managedDomainEnabled: true, expected: true },
    { isPrivate: false, managedDomainEnabled: true, expected: false },
    { isPrivate: true, managedDomainEnabled: false, expected: false },
  ])(
    "returns $expected for private=$isPrivate and enabled=$managedDomainEnabled",
    ({ expected, isPrivate, managedDomainEnabled }) => {
      expect(
        shouldUpdateR2ManagedDomain({
          isPrivate,
          managedDomainEnabled,
        }),
      ).toBe(expected);
    },
  );
});

describe("resolveR2Privacy", () => {
  it("preserves the discovered state of an existing private bucket", () => {
    expect(
      resolveR2Privacy({
        createBucket: false,
        managedDomainEnabled: false,
      }),
    ).toEqual({ isPrivate: true, kind: "resolved" });
  });

  it("asks for the policy of a new bucket", () => {
    expect(resolveR2Privacy({ createBucket: true })).toEqual({
      kind: "prompt",
    });
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
          "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
          "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
          "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
          "HOT_UPDATER_CLOUDFLARE_WORKER_NAME",
          "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
          "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME",
          "HOT_UPDATER_CLOUDFLARE_INSIGHTS_DATABASE_NAMESPACE",
          "HOT_UPDATER_CLOUDFLARE_R2_PRIVATE",
        ],
      }),
    );
  });
});
