import { describe, expect, it } from "vitest";

import {
  assertAwsNonInteractiveInputs,
  resolveAwsInitInputs,
} from "./awsInitInputs";

describe("AWS non-interactive init inputs", () => {
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
          "HOT_UPDATER_DYNAMODB_TABLE_NAME",
          "HOT_UPDATER_S3_ACCESS_KEY_ID",
          "HOT_UPDATER_S3_SECRET_ACCESS_KEY",
          "HOT_UPDATER_S3_REGION",
          "HOT_UPDATER_AWS_LAMBDA_NAME",
        ],
      }),
    );
  });

  it("accepts the complete DynamoDB-backed resource inputs", () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_AWS_AUTH_MODE: "local-session",
      HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
      HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater-metadata",
      HOT_UPDATER_S3_BUCKET_NAME: "bucket-name",
      HOT_UPDATER_S3_REGION: "ap-northeast-2",
    };
    // When
    const inputs = resolveAwsInitInputs(existingEnv);

    // Then
    expect(() => assertAwsNonInteractiveInputs(inputs, true)).not.toThrow();
  });

  it("resolves the DynamoDB table", () => {
    const existingEnv = {
      HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater-metadata",
    };

    const inputs = resolveAwsInitInputs(existingEnv);

    expect(inputs.dynamodbTableName).toBe("hot-updater-metadata");
  });
});
