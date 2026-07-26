import { afterEach, describe, expect, it } from "vitest";

import {
  assertAwsNonInteractiveInputs,
  resolveAwsInitInputs,
} from "./awsInitInputs";

describe("AWS non-interactive init inputs", () => {
  afterEach(() => {
    delete process.env.HOT_UPDATER_AWS_MIGRATION_APPROVED;
  });

  it("reports account credentials and resource inputs together", () => {
    // Given
    const inputs = resolveAwsInitInputs({
      HOT_UPDATER_AWS_AUTH_MODE: "account",
      HOT_UPDATER_S3_BUCKET_NAME: "bucket-name",
    });

    // When
    const assertInputs = () => assertAwsNonInteractiveInputs(inputs, true);

    // Then
    expect(assertInputs).toThrow(
      expect.objectContaining({
        missingInputs: [
          "HOT_UPDATER_S3_ACCESS_KEY_ID",
          "HOT_UPDATER_S3_SECRET_ACCESS_KEY",
          "HOT_UPDATER_S3_REGION",
          "HOT_UPDATER_AWS_LAMBDA_NAME",
          "HOT_UPDATER_AWS_MIGRATION_APPROVED",
        ],
      }),
    );
  });

  it("reuses saved migration approval", () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_AWS_AUTH_MODE: "local-session",
      HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
      HOT_UPDATER_AWS_MIGRATION_APPROVED: "true",
      HOT_UPDATER_S3_BUCKET_NAME: "bucket-name",
      HOT_UPDATER_S3_REGION: "ap-northeast-2",
    };
    // When
    const inputs = resolveAwsInitInputs(existingEnv);

    // Then
    expect(inputs.migrationApproved).toBe("true");
    expect(() => assertAwsNonInteractiveInputs(inputs, true)).not.toThrow();
  });
});
