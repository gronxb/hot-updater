import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const cliPath = path.resolve(__dirname, "../dist/index.mjs");

/** Runs the CLI without a TTY, as an agent or CI does. */
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, EXPERIMENTAL: "" },
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return result;
};

const help = (...command: string[]): string => {
  const result = run(...command, "--help");
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

  it.each(["show", "update", "enable", "disable", "delete"])(
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

  it("labels the advanced artifact IDs in patch help", () => {
    const output = help("patch");
    expect(output).toMatch(/artifact ID.*Advanced diagnostics/);
    expect(output).toMatch(/<artifact-id>/);
  });

  it("takes only the artifact flags for patch, with no bundle-named aliases", () => {
    const output = help("patch");
    expect(output).toContain("-b, --artifact-id <artifact-id>");
    expect(output).toContain("--base-artifact-id <artifact-id>");
    expect(output).not.toContain("--bundle-id");
    expect(output).not.toContain("--base-bundle-id");

    const alias = run(
      "patch",
      "--artifact-id",
      "artifact-a",
      "--base-artifact-id",
      "artifact-base",
      "--bundle-id",
      "artifact-a",
    );
    expect(alias.status).toBe(1);
    expect(alias.stderr).toContain("unknown option '--bundle-id'");
  });

  it("previews a bundle update with --dry-run", () => {
    expect(help("bundle", "update")).toContain("--dry-run");
  });
});

describe("CLI commands", () => {
  it.each([
    [["bundle", "preflight", "id"], "preflight"],
    [["bundle", "artifact", "delete", "id"], "artifact"],
    [["db", "catalog", "rebuild"], "catalog"],
  ])("removes %j", (command, unknown) => {
    const removed = run(...command);
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain(`unknown command '${unknown}'`);
  });

  it("prints each platform's app version with app-version", () => {
    expect(help("app-version")).toContain("--json");
  });

  it.each(["channel", "fingerprint"])(
    "shows help for bare %s, whose check moved into doctor",
    (command) => {
      const bare = run(command);
      expect(bare.stdout + bare.stderr).toContain(
        `Usage: hot-updater ${command}`,
      );
      expect(bare.stdout + bare.stderr).toMatch(/^\s+(set|create)\b/m);
    },
  );

  it("repairs with doctor --fix, which scoped verification refuses", () => {
    expect(help("doctor")).toContain("--fix");
    const scoped = run("doctor", "--fix", "--scope", "scaffold");
    expect(scoped.status).toBe(1);
    expect(scoped.stderr).toContain("cannot be used with");
  });

  it("reads the configured signing key in keys export-public, with no --input", () => {
    expect(help("keys", "export-public")).not.toContain("--input");
  });

  it("hides build:android unless EXPERIMENTAL is set", () => {
    expect(help()).not.toMatch(/^\s+build:android\b/m);
  });

  it("manages API keys with the core api-key command, and groups no plugin commands", () => {
    const output = help();
    expect(output).toMatch(/^\s+api-key\s+Manage API keys$/m);
    expect(output).not.toContain("Plugin commands");

    const apiKey = help("api-key");
    expect(apiKey).toMatch(/^\s+create \[options\] \[serverPath\]/m);
    expect(apiKey).toMatch(/^\s+list \[options\] \[serverPath\]/m);
    expect(apiKey).toMatch(/^\s+revoke \[options\] <id> \[serverPath\]/m);
    expect(help("api-key", "create")).toContain("--name <name>");
    expect(help("api-key", "list")).toContain("--json");
    expect(help("api-key", "revoke")).toContain("-y, --yes");
  });

  it("requires a name to create an API key", () => {
    const missing = run("api-key", "create");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "required option '--name <name>' not specified",
    );
  });
});
