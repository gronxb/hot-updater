import { describe, expect, it } from "vitest";

import { resolveSupabaseServiceRoleKey } from "./supabaseConfig";
import { supabaseDatabase } from "./supabaseDatabase";
import { supabaseExecutor } from "./supabaseExecutor";
import { supabaseStorage } from "./supabaseStorage";

describe("Supabase adapters without credentials", () => {
  // A config loads without its credentials, as a fingerprint or native build
  // loads it; the first request asks for the key.
  const unset = {
    supabaseUrl: undefined as never,
    supabaseServiceRoleKey: undefined as never,
  };

  it("create their clients on first use, which needs the service role key", async () => {
    expect(() => supabaseDatabase(unset)).not.toThrow();
    const storage = supabaseStorage({ ...unset, bucketName: "bundles" });

    await expect(
      storage.exists({ storageUri: "supabase-storage://bundles/key" }),
    ).rejects.toThrow("Supabase service role key is required");
  });

  it("call what creates the executor's client on the first statement", async () => {
    const executor = supabaseExecutor(() => {
      throw new Error("Supabase service role key is required.");
    });

    await expect(
      executor.execute({ sql: "select 1", params: [] }),
    ).rejects.toThrow("Supabase service role key is required");
  });
});

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
