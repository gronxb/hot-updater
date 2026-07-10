import type { d1Database as cloudflareD1Database } from "@hot-updater/cloudflare";
import type {
  CloudflareWorkerRuntimeEnv,
  d1Database as workerD1Database,
} from "@hot-updater/cloudflare/worker";
import type { ConfigInput } from "@hot-updater/plugin-core";
import type { CreateHotUpdaterOptions } from "@hot-updater/server";
import type { drizzleDatabase } from "@hot-updater/server/adapters/drizzle";
import type { kyselyDatabase } from "@hot-updater/server/adapters/kysely";
import type { mongoAdapter } from "@hot-updater/server/adapters/mongodb";
import type { prismaDatabase } from "@hot-updater/server/adapters/prisma";
import type { supabaseDatabase } from "@hot-updater/supabase";
import { describe, expectTypeOf, it } from "vitest";

type DatabaseConfig = ConfigInput["database"];
type RuntimeDatabaseConfig =
  CreateHotUpdaterOptions<CloudflareWorkerRuntimeEnv>["database"];
type AssertDatabaseConfig<T extends DatabaseConfig> = T;
type AssertRuntimeDatabaseConfig<T extends RuntimeDatabaseConfig> = T;
type PublicDatabaseAdapterReturns = readonly [
  AssertDatabaseConfig<ReturnType<typeof kyselyDatabase>>,
  AssertDatabaseConfig<ReturnType<typeof drizzleDatabase>>,
  AssertDatabaseConfig<ReturnType<typeof prismaDatabase>>,
  AssertDatabaseConfig<ReturnType<typeof cloudflareD1Database>>,
  AssertDatabaseConfig<ReturnType<typeof supabaseDatabase>>,
  AssertDatabaseConfig<ReturnType<typeof mongoAdapter>>,
];
type RuntimeDatabaseOpeners = readonly [
  AssertRuntimeDatabaseConfig<ReturnType<typeof workerD1Database>>,
];

describe("defineConfig database adapter types", () => {
  it("accepts public database adapter return values", () => {
    expectTypeOf<PublicDatabaseAdapterReturns>().not.toBeNever();
  });

  it("accepts runtime database openers such as Worker D1", () => {
    expectTypeOf<RuntimeDatabaseOpeners>().not.toBeNever();
  });
});
