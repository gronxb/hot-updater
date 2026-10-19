import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { d1Database } from "../src/d1Database";

const mocks = vi.hoisted(() => ({
  applyD1Migrations: vi.fn(async () => ({ applied: [] })),
  d1RestRunner: vi.fn(() => ({ runner: true })),
}));

vi.mock("../src/d1Migrations", () => ({
  applyD1Migrations: mocks.applyD1Migrations,
}));
vi.mock("../src/d1Rest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/d1Rest")>()),
  d1RestRunner: mocks.d1RestRunner,
}));

import { migrateDatabase } from "./index";

const PACKAGE = path.resolve(import.meta.dirname, "..");

afterEach(() => vi.clearAllMocks());

describe("migrateDatabase", () => {
  it("migrates the D1 database hot-updater.config.ts names, with every migration the package ships", async () => {
    const config = {
      accountId: "account",
      databaseId: "configured-database",
      cloudflareApiToken: "token",
    };

    await migrateDatabase({
      cwd: PACKAGE,
      database: d1Database(config),
      nonInteractive: true,
    });

    expect(mocks.d1RestRunner).toHaveBeenCalledWith(config);
    const names = (
      await fs.readdir(path.join(PACKAGE, "worker/migrations"))
    ).filter((name) => name.endsWith(".sql"));
    expect(mocks.applyD1Migrations).toHaveBeenCalledWith(
      { runner: true },
      expect.arrayContaining(
        names.map((name) =>
          expect.objectContaining({ name, sql: expect.any(String) }),
        ),
      ),
    );
  });

  it("refuses a database d1Database did not make", async () => {
    await expect(
      migrateDatabase({
        cwd: PACKAGE,
        database: { name: "d1Database" } as never,
        nonInteractive: true,
      }),
    ).resolves.toEqual({ skip: expect.stringContaining("d1Database") });
    expect(mocks.applyD1Migrations).not.toHaveBeenCalled();
  });
});
