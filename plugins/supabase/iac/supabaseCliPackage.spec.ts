import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SUPABASE_CLI } from "./supabaseCliPackage";

describe("SUPABASE_CLI", () => {
  it("is the CLI the agent setup guide runs", async () => {
    const setup = await fs.readFile(
      path.resolve(import.meta.dirname, "../agent/SETUP.md"),
      "utf-8",
    );
    const commands = [...setup.matchAll(/`npx ([^`]*supabase[^`]*)`/g)].map(
      ([, command]) => command!,
    );

    expect(commands).not.toHaveLength(0);
    for (const command of commands) {
      expect(command).toMatch(
        new RegExp(`^-y ${SUPABASE_CLI.replace(/\./g, "\\.")} `),
      );
    }
  });
});
