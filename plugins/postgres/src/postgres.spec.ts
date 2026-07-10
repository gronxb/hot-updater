import { describe, expect, it } from "vitest";

import { postgres } from "./postgres";

const getRuntimeMetadata = (runtime: object) => ({
  adapterName: "adapterName" in runtime ? runtime.adapterName : undefined,
  provider: "provider" in runtime ? runtime.provider : undefined,
  createMigrator:
    "createMigrator" in runtime ? runtime.createMigrator : undefined,
});

describe("postgres database", () => {
  it("creates a Kysely-backed Postgres runtime", async () => {
    const runtime = postgres({
      connectionString: "postgresql://user:password@localhost:5432/hot_updater",
    });
    const metadata = getRuntimeMetadata(runtime);

    expect(metadata.adapterName).toBe("kysely");
    expect(metadata.provider).toBe("postgresql");
    expect(metadata.createMigrator).toBeTypeOf("function");
    await runtime.close?.();
  });
});
