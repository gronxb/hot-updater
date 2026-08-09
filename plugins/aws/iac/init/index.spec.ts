import {
  getMissingInitProviderInputs,
  resolveInitProviderInputs,
} from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { initProvider } from "./index";

describe("AWS init provider", () => {
  it("requires a table name only for DynamoDB metadata", () => {
    // Given
    const dynamodbEnv = {
      HOT_UPDATER_AWS_AUTH_MODE: "local-session",
      HOT_UPDATER_AWS_DATABASE: "dynamodb",
      HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
      HOT_UPDATER_S3_BUCKET_NAME: "updates",
      HOT_UPDATER_S3_REGION: "ap-northeast-2",
    };
    const s3Env = {
      ...dynamodbEnv,
      HOT_UPDATER_AWS_DATABASE: "s3",
    };

    // When
    const dynamodbInputs = resolveInitProviderInputs(dynamodbEnv, initProvider);
    const s3Inputs = resolveInitProviderInputs(s3Env, initProvider);

    // Then
    expect(
      getMissingInitProviderInputs({
        inputs: dynamodbInputs,
        provider: initProvider,
      }),
    ).toContain("HOT_UPDATER_DYNAMODB_TABLE_NAME");
    expect(
      getMissingInitProviderInputs({
        inputs: s3Inputs,
        provider: initProvider,
      }),
    ).not.toContain("HOT_UPDATER_DYNAMODB_TABLE_NAME");
  });

  it("validates auth mode and region through its declaration", () => {
    // Given
    const env = {
      HOT_UPDATER_AWS_AUTH_MODE: "invalid",
      HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
      HOT_UPDATER_AWS_MIGRATION_APPROVED: "true",
      HOT_UPDATER_S3_BUCKET_NAME: "updates",
      HOT_UPDATER_S3_REGION: "not-a-region",
    };

    // When
    const inputs = resolveInitProviderInputs(env, initProvider);

    // Then
    expect(
      getMissingInitProviderInputs({ inputs, provider: initProvider }),
    ).toEqual(["HOT_UPDATER_AWS_AUTH_MODE", "HOT_UPDATER_S3_REGION"]);
  });
});
