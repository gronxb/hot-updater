import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SUPABASE_CLI } from "./supabaseCliPackage";

const setupCommands = async () => {
  const setup = await fs.readFile(
    path.resolve(import.meta.dirname, "../agent/SETUP.md"),
    "utf-8",
  );
  return [...setup.matchAll(/`npx ([^`]*supabase[^`]*)`/g)].map(
    ([, command]) => command!,
  );
};

describe("SUPABASE_CLI", () => {
  it("is the CLI the agent setup guide runs", async () => {
    const commands = await setupCommands();

    expect(commands).not.toHaveLength(0);
    for (const command of commands) {
      expect(command).toMatch(
        new RegExp(`^-y ${SUPABASE_CLI.replace(/\./g, "\\.")} `),
      );
    }
  });

  it("is a Supabase CLI 3 version, whose flags the guide uses", () => {
    expect(SUPABASE_CLI).toMatch(/^supabase@3\.\d+\.\d+$/);
  });

  // Supabase CLI 3 runs `db push` and `migration fetch` without a target on
  // the local stack, deprecates `--linked` and `--project-ref` for
  // `--remote`, and fails a hosted change without a terminal unless `--yes`.
  it("runs the guide's commands on the hosted project, unattended", async () => {
    const commands = await setupCommands();
    const args = (command: string) => command.split(" ").slice(2);

    for (const command of commands) {
      expect(args(command)).not.toContain("--linked");
      expect(args(command)).not.toContain("--project-ref");
    }
    const run = (name: string) =>
      args(
        commands.find((command) => args(command).join(" ").startsWith(name))!,
      );
    expect(run("link")).toEqual(["link", "<project-id>"]);
    expect(run("migration fetch")).toEqual(
      expect.arrayContaining(["--remote", "--yes"]),
    );
    expect(run("db push")).toEqual(
      expect.arrayContaining(["--remote", "--yes"]),
    );
    expect(run("functions deploy")).toEqual(
      expect.arrayContaining(["--remote=<project-id>", "--yes"]),
    );
  });
});
