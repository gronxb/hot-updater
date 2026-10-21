import { afterEach, describe, expect, it, vi } from "vitest";

import { supabaseDatabase } from "../src/supabaseMigration";

const mocks = vi.hoisted(() => ({
  pushPendingMigrations: vi.fn(async () => ({ applied: [] })),
  managedEnv: {} as Record<string, string>,
}));

vi.mock("./supabaseCli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabaseCli")>()),
  pushPendingMigrations: mocks.pushPendingMigrations,
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  readHotUpdaterInitEnv: vi.fn(async () => ({
    env: {},
    managedEnv: mocks.managedEnv,
  })),
}));

import { migrateDatabase } from "./index";

const configured = supabaseDatabase({
  supabaseUrl: "https://configured.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.managedEnv = {};
});

describe("migrateDatabase", () => {
  it("pushes to the project hot-updater.config.ts names, with the password saved for it", async () => {
    mocks.managedEnv = {
      HOT_UPDATER_SUPABASE_PROJECT_ID: "configured",
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "saved-password",
      HOT_UPDATER_SUPABASE_DB_PASSWORD_PROJECT_ID: "configured",
    };

    await expect(
      migrateDatabase({
        cwd: process.cwd(),
        database: configured,
        nonInteractive: true,
      }),
    ).resolves.toEqual({ applied: [] });
    expect(mocks.pushPendingMigrations).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        projectId: "configured",
        dbPassword: "saved-password",
      }),
    );
  });

  it("never sends another project's saved password", async () => {
    mocks.managedEnv = {
      HOT_UPDATER_SUPABASE_PROJECT_ID: "stale",
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "stale-password",
      HOT_UPDATER_SUPABASE_DB_PASSWORD_PROJECT_ID: "stale",
    };

    await expect(
      migrateDatabase({
        cwd: process.cwd(),
        database: configured,
        nonInteractive: true,
      }),
    ).resolves.toEqual({
      skip: expect.stringContaining("HOT_UPDATER_SUPABASE_DB_PASSWORD"),
    });
    expect(mocks.pushPendingMigrations).not.toHaveBeenCalled();
  });
});
