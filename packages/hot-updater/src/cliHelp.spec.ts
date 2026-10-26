import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const cliPath = path.resolve(__dirname, "../dist/index.mjs");

/** Runs the CLI without a TTY, as an agent or CI does. */
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
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

  it("lists the bundle management commands together", () => {
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

  it("documents the channel and target app version filters of bundle list", () => {
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

  it("lists the native build and run commands without a flag", () => {
    const output = help();
    for (const command of [
      "build:android",
      "build:ios",
      "run:android",
      "run:ios",
    ]) {
      expect(output).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
    }
    expect(help("build:ios")).toContain("--scheme <scheme>");
    expect(help("build:ios")).not.toContain("--message");
    expect(help("run:android")).not.toContain("--app-id-suffix");
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

  it("stores build credentials with secrets put and secrets issue, without --app", () => {
    expect(help()).toMatch(
      /^\s+secrets\s+Store build credentials in the secrets adapter$/m,
    );
    const secrets = help("secrets");
    expect(secrets).toMatch(/^\s+put \[options\] <name>\s/m);
    expect(secrets).toMatch(/^\s+issue \[options\] <kind> \[name\]\s/m);
    for (const removed of ["list", "env", "import", "token"]) {
      expect(secrets).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
    }
    expect(help("secrets", "put")).not.toContain("--app");
    const put = help("secrets", "put").replace(/\s+/gu, " ");
    expect(put).toContain('choices: "asc-api-key", "android-keystore"');
    expect(put).toContain("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD");
    expect(help("keys", "generate")).not.toContain("--vault");
    expect(help("keys", "generate")).toContain("--secret [name]");

    // put stores a key you have: its help no longer offers a sign-in.
    expect(put).not.toMatch(/sign in with/i);
    expect(put).toContain("run secrets issue");

    const issue = help("secrets", "issue").replace(/\s+/gu, " ");
    expect(issue).toContain('choices: "asc-api-key", "play-service-account"');
    expect(issue).not.toContain("android-keystore");
    expect(issue).toContain("--replace");
    expect(issue).toContain("never revokes the old key");
    expect(issue).toContain(
      "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID and HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET",
    );
    expect(issue).toContain("secrets put instead");
    for (const removed of ["login", "logout", "whoami"]) {
      expect(help()).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
      expect(secrets).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
    }

    const keystore = run("secrets", "issue", "android-keystore");
    expect(keystore.status).toBe(1);
    expect(keystore.stderr).toContain(
      "'android-keystore' is invalid for argument 'kind'. Allowed choices are asc-api-key, play-service-account.",
    );
    // No terminal: it refuses before reading the config or signing in.
    const noTerminal = run("secrets", "issue", "asc-api-key");
    expect(noTerminal.status).toBe(1);
    expect(noTerminal.stdout + noTerminal.stderr).toContain(
      "Run `npx hot-updater secrets issue asc-api-key` in a terminal",
    );

    const missing = run("secrets", "put", "release-keystore");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "required option '--kind <kind>' not specified",
    );
  });

  it("manages Remote Config with remote-config, by version number", () => {
    expect(help()).toMatch(
      /^\s+remote-config\s+Show, publish, and roll back Remote Config templates$/m,
    );
    const remoteConfig = help("remote-config");
    expect(remoteConfig).toMatch(/^\s+show \[options\] \[serverPath\]/m);
    expect(remoteConfig).toMatch(/^\s+versions \[options\] \[serverPath\]/m);
    expect(remoteConfig).toMatch(
      /^\s+publish \[options\] <file> \[serverPath\]/m,
    );
    expect(remoteConfig).toMatch(
      /^\s+rollback \[options\] <version> \[serverPath\]/m,
    );
    expect(remoteConfig).toMatch(/^\s+preview \[options\] \[serverPath\]/m);
    // --version is the CLI's own: it would print the CLI's version.
    expect(help("remote-config", "show")).toContain("--version-number <n>");
    expect(help("remote-config", "preview")).toContain("--version-number <n>");
    const publish = help("remote-config", "publish");
    expect(publish).toContain("--expected-version <n>");
    expect(publish).toContain("--dry-run");
    expect(publish).toContain("-y, --yes");

    const rollback = run("remote-config", "rollback", "latest");
    expect(rollback.status).toBe(1);
    expect(rollback.stderr).toContain("must be an integer of at least 1");
  });

  it("reads Insights with insights, in the console's words", () => {
    expect(help()).toMatch(/^\s+insights\s+Read Insights:/m);
    const insights = help("insights");
    for (const command of ["overview", "failures", "events"]) {
      expect(insights).toMatch(
        new RegExp(`^\\s+${command} \\[options\\] \\[serverPath\\]`, "m"),
      );
    }
    expect(insights).toMatch(
      /^\s+installations \[options\] <id> \[serverPath\]/m,
    );
    expect(help("insights", "overview")).toContain("--bundle <id>");
    // Help wraps long lines.
    const oneLine = (...command: string[]) =>
      help(...command).replace(/\s+/gu, " ");
    expect(oneLine("insights", "events")).toContain(
      'choices: "downloaded", "launched", "crashed", "failed"',
    );
    expect(oneLine("insights", "failures")).toContain(
      'choices: "24h", "7d", "30d"',
    );
  });

  it("requires a name to create an API key", () => {
    const missing = run("api-key", "create");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "required option '--name <name>' not specified",
    );
  });
});
