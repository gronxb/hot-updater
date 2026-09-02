import {
  getMissingInitProviderInputs,
  resolveInitProviderInputs,
} from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { initProvider } from "./index";

describe("AWS init provider", () => {
  it("uses isolated v1 compute and metadata defaults", () => {
    expect(initProvider.inputs.lambdaName.prompt.defaultValue).toBe(
      "hot-updater-v1-edge",
    );
    expect(initProvider.inputs.dynamodbTableName.prompt.defaultValue).toBe(
      "hot-updater-v1",
    );
  });

  it("always requires a DynamoDB metadata table", () => {
    const env = {
      HOT_UPDATER_AWS_AUTH_MODE: "local-session",
      HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
      HOT_UPDATER_S3_BUCKET_NAME: "updates",
      HOT_UPDATER_S3_REGION: "ap-northeast-2",
    };
    const inputs = resolveInitProviderInputs(env, initProvider);

    expect(
      getMissingInitProviderInputs({
        inputs,
        provider: initProvider,
      }),
    ).toContain("HOT_UPDATER_DYNAMODB_TABLE_NAME");
    expect(
      getMissingInitProviderInputs({
        inputs,
        provider: initProvider,
      }),
    ).toContain("HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE");
  });

  it("validates auth mode and region through its declaration", () => {
    // Given
    const env = {
      HOT_UPDATER_AWS_AUTH_MODE: "invalid",
      HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
      HOT_UPDATER_S3_BUCKET_NAME: "updates",
      HOT_UPDATER_S3_REGION: "not-a-region",
    };

    // When
    const inputs = resolveInitProviderInputs(env, initProvider);

    // Then
    expect(
      getMissingInitProviderInputs({ inputs, provider: initProvider }),
    ).toEqual([
      "HOT_UPDATER_DYNAMODB_TABLE_NAME",
      "HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE",
      "HOT_UPDATER_AWS_AUTH_MODE",
      "HOT_UPDATER_S3_REGION",
    ]);
  });
});
