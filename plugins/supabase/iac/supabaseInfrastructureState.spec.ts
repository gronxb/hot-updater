import { describe, expect, it, vi } from "vitest";

import type { SupabaseApi } from "./supabaseApi";
import { assertSupabaseInfrastructureCanInitialize } from "./supabaseInfrastructureState";

const api = (state: "fresh" | "v0" | "v1") =>
  ({
    getInfrastructureState: vi.fn().mockResolvedValue(state),
  }) as unknown as SupabaseApi;

describe("Supabase infrastructure generation", () => {
  it.each(["fresh", "v1"] as const)("allows %s projects", async (state) => {
    await expect(
      assertSupabaseInfrastructureCanInitialize(api(state), "project-ref"),
    ).resolves.toBeUndefined();
  });

  it("blocks a v0 project", async () => {
    await expect(
      assertSupabaseInfrastructureCanInitialize(api("v0"), "project-ref"),
    ).rejects.toThrow(
      "Supabase v0 infrastructure was detected at project project-ref",
    );
  });
});
