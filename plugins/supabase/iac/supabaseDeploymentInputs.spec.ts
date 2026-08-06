import { describe, expect, it, vi } from "vitest";

import {
  assertSupabaseNonInteractiveInputs,
  inputSupabaseDeploymentInputs,
  resolveSupabaseInitInputs,
} from "./supabaseInitInputs";

describe("Supabase deployment inputs", () => {
  it("uses a valid CLI login when env-file omits the access token", async () => {
    // Given
    const inputs = resolveSupabaseInitInputs({
      HOT_UPDATER_SUPABASE_BUCKET_NAME: "updates",
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "project-ref",
    });
    const hasValidCliLogin = vi.fn().mockResolvedValue(true);

    // When
    await expect(
      assertSupabaseNonInteractiveInputs(inputs, true, hasValidCliLogin),
    ).resolves.toBeUndefined();
    const deploymentInputs = await inputSupabaseDeploymentInputs({
      ...inputs,
      nonInteractive: true,
    });

    // Then
    expect(deploymentInputs).toEqual({
      accessToken: undefined,
      functionName: "update-server",
    });
    expect(hasValidCliLogin).toHaveBeenCalledOnce();
  });

  it("reports the access token when neither token nor CLI login is available", async () => {
    const inputs = resolveSupabaseInitInputs({});

    await expect(
      assertSupabaseNonInteractiveInputs(inputs, true, async () => false),
    ).rejects.toEqual(
      expect.objectContaining({
        missingInputs: [
          "HOT_UPDATER_SUPABASE_PROJECT_ID",
          "SUPABASE_ACCESS_TOKEN",
          "HOT_UPDATER_SUPABASE_BUCKET_NAME",
          "HOT_UPDATER_SUPABASE_FUNCTION_NAME",
        ],
      }),
    );
  });

  it("rejects an unsafe saved Edge Function name", async () => {
    const inputs = resolveSupabaseInitInputs({
      HOT_UPDATER_SUPABASE_BUCKET_NAME: "updates",
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "../outside",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "project-ref",
      SUPABASE_ACCESS_TOKEN: "access-token",
    });

    await expect(
      assertSupabaseNonInteractiveInputs(inputs, true),
    ).rejects.toEqual(
      expect.objectContaining({
        missingInputs: ["HOT_UPDATER_SUPABASE_FUNCTION_NAME"],
      }),
    );
  });
});
