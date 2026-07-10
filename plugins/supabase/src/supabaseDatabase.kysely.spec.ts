import { describe, expect, it } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";

const getRuntimeMetadata = (runtime: object) => ({
  adapterName: "adapterName" in runtime ? runtime.adapterName : undefined,
  provider: "provider" in runtime ? runtime.provider : undefined,
  createMigrator:
    "createMigrator" in runtime ? runtime.createMigrator : undefined,
});

describe("supabaseDatabase official path", () => {
  it("creates a Kysely-backed Postgres runtime", async () => {
    const runtime = supabaseDatabase({
      connectionString:
        "postgresql://postgres:password@db.example.supabase.co:5432/postgres",
    });
    const metadata = getRuntimeMetadata(runtime);

    expect(metadata.adapterName).toBe("kysely");
    expect(metadata.provider).toBe("postgresql");
    expect(metadata.createMigrator).toBeTypeOf("function");
    await runtime.close?.();
  });
});
