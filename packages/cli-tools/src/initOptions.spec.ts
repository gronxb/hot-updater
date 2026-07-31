import { describe, expect, it } from "vitest";

import { assertInitInputs, MissingInitInputsError } from "./initOptions";

describe("assertInitInputs", () => {
  it("reports every missing input in declaration order", () => {
    // Given
    const inputs = {
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: undefined,
      HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: " ",
      HOT_UPDATER_CLOUDFLARE_WORKER_NAME: "worker-name",
    };

    // When
    const readError = () =>
      assertInitInputs({
        inputs,
        strict: true,
      });

    // Then
    expect(readError).toThrow(MissingInitInputsError);
    try {
      readError();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingInitInputsError);
      if (error instanceof MissingInitInputsError) {
        expect(error.missingInputs).toEqual([
          "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
          "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
        ]);
      }
    }
  });

  it("allows missing values during interactive init", () => {
    expect(() =>
      assertInitInputs({
        inputs: {
          HOT_UPDATER_INIT_BUILD: undefined,
          HOT_UPDATER_INIT_PROVIDER: undefined,
        },
        strict: false,
      }),
    ).not.toThrow();
  });
});
