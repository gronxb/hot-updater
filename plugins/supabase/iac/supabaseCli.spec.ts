import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pushPendingMigrations } from "./supabaseCli";

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: mocks.execa,
}));

const MIGRATIONS = path.resolve(import.meta.dirname, "../supabase/migrations");

/** `supabase migration list`'s table for the versions the project ran. */
const migrationList = (local: readonly string[], remote: readonly string[]) =>
  [
    "",
    "   Local | Remote | Time (UTC)",
    "  -------|--------|------------",
    ...[...new Set([...local, ...remote])]
      .sort()
      .map(
        (version) =>
          `   ${local.includes(version) ? version : ""} | ${remote.includes(version) ? version : ""} | ${version}`,
      ),
    "",
  ].join("\n");

let workdir: string;
let names: string[];
/** The Supabase CLI commands run, by their first two words. */
let commands: string[];

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sb-cli-"));
  await fs.cp(MIGRATIONS, path.join(workdir, "supabase", "migrations"), {
    recursive: true,
  });
  names = (await fs.readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql"));
  commands = [];
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

/** A linked project whose history holds `remote`. */
const project = (remote: readonly string[]) =>
  mocks.execa.mockImplementation(
    async (_command: string, args: readonly string[] = []) => {
      commands.push(args.slice(1, 3).join(" "));
      if (args.includes("list")) {
        return {
          stdout: migrationList(
            names.map((name) => name.split("_")[0]!),
            remote,
          ),
        };
      }
      return { stdout: "" };
    },
  );

describe("pushPendingMigrations", () => {
  it("pushes the package's migrations a managed project has not run", async () => {
    project(["0001"]);

    await expect(
      pushPendingMigrations(workdir, {
        projectId: "project-ref",
        dbPassword: "database-password",
      }),
    ).resolves.toEqual({ applied: names.slice(1) });
    expect(commands).toEqual([
      "link --project-ref",
      "migration list",
      "migration fetch",
      "db push",
    ]);
  });

  it("pushes nothing to a project that ran every migration", async () => {
    project(names.map((name) => name.split("_")[0]!));

    await expect(
      pushPendingMigrations(workdir, { projectId: "project-ref" }),
    ).resolves.toEqual({ applied: [] });
    expect(commands).toEqual(["link --project-ref", "migration list"]);
  });

  it("leaves alone a project the managed init did not create", async () => {
    project(["20260101000000"]);

    await expect(
      pushPendingMigrations(workdir, { projectId: "project-ref" }),
    ).resolves.toEqual({
      skip: expect.stringContaining("hot-updater db generate"),
    });
    expect(commands).not.toContain("db push");
  });

  it("throws with the CLI's message when a command fails", async () => {
    mocks.execa.mockRejectedValue(new Error("Cannot find project ref."));

    await expect(
      pushPendingMigrations(workdir, { projectId: "project-ref" }),
    ).rejects.toThrow("Cannot find project ref.");
  });
});
