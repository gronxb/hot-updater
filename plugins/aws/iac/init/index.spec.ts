import {
  getMissingInitProviderInputs,
  resolveInitProviderInputs,
} from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { initProvider } from "./index";

describe("AWS init provider", () => {
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
