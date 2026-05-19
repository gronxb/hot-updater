import { describe, expect, it } from "vitest";

import { resolveSupabaseServiceRoleKey } from "./supabaseConfig";

describe("resolveSupabaseServiceRoleKey", () => {
  it("prefers the explicit service role key", () => {
    expect(
      resolveSupabaseServiceRoleKey({
        supabaseUrl: "https://test.supabase.invalid",
        supabaseServiceRoleKey: "service-role-key",
        supabaseAnonKey: "legacy-key",
      }),
    ).toBe("service-role-key");
  });

  it("keeps legacy supabaseAnonKey config working", () => {
    expect(
      resolveSupabaseServiceRoleKey({
        supabaseUrl: "https://test.supabase.invalid",
        supabaseAnonKey: "legacy-key",
      }),
    ).toBe("legacy-key");
  });
});
