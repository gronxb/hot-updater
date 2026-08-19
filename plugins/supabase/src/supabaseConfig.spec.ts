import { describe, expect, it } from "vitest";

import { resolveSupabaseServiceRoleKey } from "./supabaseConfig";

describe("resolveSupabaseServiceRoleKey", () => {
  it("returns the service role key", () => {
    expect(
      resolveSupabaseServiceRoleKey({
        supabaseUrl: "https://test.supabase.invalid",
        supabaseServiceRoleKey: "service-role-key",
      }),
    ).toBe("service-role-key");
  });

  it("rejects a missing service role key", () => {
    expect(() =>
      resolveSupabaseServiceRoleKey({
        supabaseUrl: "https://test.supabase.invalid",
        supabaseServiceRoleKey: "",
      }),
    ).toThrow("Supabase service role key is required");
  });
});
