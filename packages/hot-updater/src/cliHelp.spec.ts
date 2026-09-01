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

describe("CLI bundle mental model", () => {
  it("exposes bundle management without a release command", () => {
    const output = help();
    expect(output).toMatch(/\bbundle\b/);
    expect(output).not.toMatch(/^\s+release\b/m);
    expect(output).not.toMatch(/^\s+artifact\b/m);

    const removedCommand = spawnSync(process.execPath, [cliPath, "release"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(removedCommand.error).toBeUndefined();
    expect(removedCommand.status).toBe(1);
    expect(removedCommand.stderr).toContain("unknown command 'release'");
  });

  it.each(["show", "update", "preflight", "enable", "disable", "delete"])(
    "uses the console ID for bundle %s",
    (command) => {
      const output = help("bundle", command);
      expect(output).toContain("<id>");
      expect(output).toContain("the ID shown in the console");
      expect(output).not.toContain("<release-id>");
      expect(output).not.toContain("artifact ID");
    },
  );

  it("keeps the v0 bundle management verbs together", () => {
    const output = help("bundle");
    for (const command of [
      "list",
      "show",
      "update",
      "enable",
      "disable",
      "delete",
      "promote",
    ]) {
      expect(output).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
    }
  });

  it("keeps the v0 bundle list filters", () => {
    const output = help("bundle", "list");
    expect(output).toContain("-c, --channel <channel>");
    expect(output).toContain("--target-app-version <targetAppVersion>");
  });

  it("uses the source console ID for bundle promotion", () => {
    const output = help("bundle", "promote");
    expect(output).toContain("<source-id>");
    expect(output).toContain("the source ID shown in the console");
  });

  it.each([["bundle", "artifact", "delete"], ["patch"]])(
    "labels the advanced artifact IDs in %s %s help",
    (...command) => {
      const output = help(...command);
      expect(output).toMatch(/artifact ID.*Advanced diagnostics/);
      expect(output).toMatch(/<artifact-ids?(?:\.\.\.)?>/);
    },
  );

  it("uses canonical artifact flags for patch and hides bundle-named aliases", () => {
    const output = help("patch");
    expect(output).toContain("-b, --artifact-id <artifact-id>");
    expect(output).toContain("--base-artifact-id <artifact-id>");
    expect(output).not.toContain("--bundle-id");
    expect(output).not.toContain("--base-bundle-id");

    const conflict = spawnSync(
      process.execPath,
      [
        cliPath,
        "patch",
        "--artifact-id",
        "artifact-a",
        "--bundle-id",
        "artifact-b",
        "--base-artifact-id",
        "artifact-base",
        "--platform",
        "ios",
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );
    expect(conflict.error).toBeUndefined();
    expect(conflict.status).toBe(1);
    expect(`${conflict.stdout}\n${conflict.stderr}`).toContain(
      "Provide only one value for --artifact-id.",
    );
  });
});
