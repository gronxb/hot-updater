import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const cliPath = path.resolve(__dirname, "../dist/index.mjs");

const help = (...command: string[]): string => {
  const result = spawnSync(process.execPath, [cliPath, ...command, "--help"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
};

describe("CLI ID help", () => {
  it.each(["show", "update", "preflight", "enable", "disable", "delete"])(
    "uses the console ID for release %s",
    (command) => {
      const output = help("release", command);
      expect(output).toContain("<id>");
      expect(output).toContain("the ID shown in the console");
      expect(output).not.toContain("<release-id>");
    },
  );

  it("uses the source console ID for promotion", () => {
    const output = help("release", "promote");
    expect(output).toContain("<source-id>");
    expect(output).toContain("the source ID shown in the console");
  });

  it.each([["release", "list"], ["bundle", "delete"], ["patch"]])(
    "identifies file operations in %s %s help",
    (...command) => {
      const output = help(...command);
      expect(output).toMatch(/file ID.*Advanced diagnostics/);
      expect(output).toMatch(/<file-ids?(?:\.\.\.)?>/);
    },
  );
});
