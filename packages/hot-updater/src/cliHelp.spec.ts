import { spawnSync } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

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

/** asc, the App Store Connect CLI, which Hot Updater no longer runs. */
const NAMES_ASC = /App Store Connect CLI|\basc\b(?!-api-key)/u;

/** The lines of a refusal clack prints, without the gutter. */
const refusal = (result: { stdout: string; stderr: string }) =>
  stripVTControlCharacters(result.stdout + result.stderr)
    .split("\n")
    .filter((line) => /^[■│] {2}\S/u.test(line))
    .map((line) => line.slice(3));

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

  it("reports with doctor, which has no --fix", () => {
    expect(help("doctor")).not.toContain("--fix");
    const fix = run("doctor", "--fix");
    expect(fix.status).toBe(1);
    expect(fix.stderr).toContain("unknown option '--fix'");
  });

  it("reads the configured signing key in keys export-public, with no --input", () => {
    expect(help("keys", "export-public")).not.toContain("--input");
  });

  it("builds with native-build ios|android, with no build:* or run:* commands", () => {
    const output = help();
    for (const removed of [
      "build:android",
      "build:ios",
      "run:android",
      "run:ios",
    ]) {
      expect(output).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
      const result = run(removed);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unknown command '${removed}'`);
    }

    const nativeBuild = help("native-build");
    for (const command of ["find", "delete", "ios", "android"]) {
      expect(nativeBuild).toMatch(new RegExp(`^\\s+${command} \\[`, "m"));
    }
    expect(nativeBuild).not.toMatch(/^\s+create\b/m);
    // No -p on the parent: it would break find -p and the subcommands.
    expect(nativeBuild).not.toContain("--platform");
    const bare = run("native-build");
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("Usage: hot-updater native-build");
    expect(bare.stderr).toMatch(/^\s+ios \[options\]/m);

    for (const [platform, destination] of [
      ["ios", "testflight"],
      ["android", "play-internal"],
    ] as const) {
      const build = help("native-build", platform);
      const flat = build.replace(/\s+/gu, " ");
      expect(build).toContain("-s, --scheme <scheme>");
      expect(build).toContain("-o, --output-path <outputPath>");
      expect(flat).toContain(`--submit <destination>`);
      expect(flat).toContain(`(choices: "${destination}")`);
      expect(flat).toContain(
        "--dry-run Build, but record and submit nothing: no Hot Updater tracking, no store submission (like npm publish --dry-run)",
      );
      expect(build).toContain("--json");
      for (const removed of [
        "--upload",
        "--register",
        "--no-register",
        "--untracked",
        "--interactive",
        "--device",
      ]) {
        expect(build).not.toContain(removed);
      }
      const wrong = run(
        "native-build",
        platform,
        "--submit",
        destination === "testflight" ? "play-internal" : "testflight",
      );
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain("is invalid. Allowed choices are");
      for (const removed of ["--upload", "--untracked", "--no-register"]) {
        const refused = run("native-build", platform, removed, destination);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(`unknown option '${removed}'`);
      }
    }

    // -p parses on find, which has its own: commander reads the subcommand's.
    const find = run("native-build", "find", "-p", "ios", "--help");
    expect(find.status).toBe(0);
    expect(find.stdout).toContain("-p, --platform <platform>");
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
    expect(secrets).toMatch(
      /^\s+import \[env-file\]\s+Store the deploy credentials/m,
    );
    for (const removed of ["list", "env", "token"]) {
      expect(secrets).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
    }
    expect(help("secrets", "put")).not.toContain("--app");
    const put = help("secrets", "put").replace(/\s+/gu, " ");
    expect(put).toContain('choices: "asc-api-key", "android-keystore"');
    expect(put).toContain("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD");
    // secrets issue bundle-signing-key creates the signing key.
    expect(help("keys")).not.toMatch(/^\s+generate\b/m);

    // put stores a key you have: its help no longer offers a sign-in.
    expect(put).not.toMatch(/sign in with/i);
    expect(put).toContain(
      "To sign in and issue an App Store Connect API key, run apple login.",
    );
    expect(put).toContain("secrets put play-service-account <key.json>");
    expect(put).toContain("secrets put android-keystore <upload.jks>");

    const issue = help("secrets", "issue").replace(/\s+/gu, " ");
    expect(issue).toContain(
      'choices: "asc-api-key", "android-keystore", "bundle-signing-key"',
    );
    expect(issue).toContain(
      "A stored key is kept: apps already shipped reject a new key's bundles.",
    );
    // A Play service account is a file you store: nothing issues one.
    expect(issue).not.toContain("play-service-account");
    expect(issue).not.toContain("gcloud");
    expect(issue).toContain("--pem <file>");
    expect(issue).toContain("--replace");
    expect(issue).toContain("never revokes the old key");
    expect(issue).toContain("only an app with no .aab on Google Play yet");
    expect(issue).not.toContain("OAuth client");
    // Hot Updater signs in to Apple itself: no asc binary is involved.
    expect(issue).toContain(
      "asc-api-key signs in to your Apple Account in Hot Updater's own prompts.",
    );
    expect(issue).not.toMatch(NAMES_ASC);
    expect(issue).toContain("secrets put instead");
    for (const removed of ["login", "logout", "whoami"]) {
      expect(help()).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
      expect(secrets).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "m"));
    }

    // No terminal: it creates no upload key, which a runner would lose.
    const keystore = run("secrets", "issue", "android-keystore");
    expect(keystore.status).toBe(1);
    expect(
      stripVTControlCharacters(keystore.stdout + keystore.stderr),
    ).toContain(
      "Run in a terminal: npx hot-updater secrets issue android-keystore",
    );
    // No terminal, and localSecrets(): a key the runner keeps would be lost.
    const signingKey = run("secrets", "issue", "bundle-signing-key");
    expect(signingKey.status).toBe(1);
    // Without a terminal, or in CI, which names its variable.
    expect(refusal(signingKey)).toEqual([
      expect.stringMatching(
        /^Can't create a bundle signing key (without a terminal|in CI \(CI is set\))\.$/u,
      ),
      "Run in a terminal: npx hot-updater secrets issue bundle-signing-key",
    ]);
    const pem = run("secrets", "issue", "asc-api-key", "--pem", "a.pem");
    expect(pem.status).toBe(1);
    expect(stripVTControlCharacters(pem.stdout + pem.stderr)).toContain(
      "--pem is for android-keystore, not asc-api-key.",
    );
    // No terminal: it refuses before reading the config or signing in.
    const noTerminal = run("secrets", "issue", "asc-api-key");
    expect(noTerminal.status).toBe(1);
    // Without colors, which CI turns on.
    expect(
      stripVTControlCharacters(noTerminal.stdout + noTerminal.stderr),
    ).toContain("Run in a terminal: npx hot-updater apple login");

    const missing = run("secrets", "put", "release-keystore");
    expect(missing.status).toBe(1);
    expect(stripVTControlCharacters(missing.stdout + missing.stderr)).toContain(
      "Pass --kind: release-keystore is not a kind.",
    );
  });

  it("has no google-play login: Google Play's files are stored with secrets put", () => {
    expect(help("google-play")).not.toMatch(/^\s+login\b/m);
    const login = run("google-play", "login");
    expect(login.status).toBe(1);
    expect(login.stderr).toContain("unknown command 'login'");
  });

  it.each([["apple", "asc-api-key", "Apple Account", "Google"]] as const)(
    "has %s login as the alias of secrets issue %s, taking nothing, and keeps no session",
    (group, kind, account, otherKind) => {
      expect(help()).toMatch(new RegExp(`^\\s+${group}\\s+\\S`, "m"));
      const groupHelp = help(group);
      expect(groupHelp).toMatch(/^\s+login\s+Alias of/m);
      // Hot Updater keeps no session: nothing to log out of or ask about.
      for (const missing of ["logout", "whoami", "status"]) {
        expect(groupHelp).not.toMatch(new RegExp(`^\\s+${missing}\\b`, "m"));
      }
      const loginHelp = help(group, "login");
      const login = loginHelp.replace(/\s+/gu, " ");
      expect(login).toContain(`Alias of \`hot-updater secrets issue ${kind}\``);
      expect(login).toContain(account);
      expect(login).not.toContain(otherKind);
      expect(login).not.toMatch(NAMES_ASC);
      expect(login).toContain("Hot Updater keeps no session");
      expect(login).toContain("no logout or whoami");
      expect(loginHelp).not.toMatch(/^\s+--replace/m);
      expect(loginHelp).not.toContain("[name]");

      // The alias runs secrets issue's handler with its kind: without a
      // terminal, both print the same refusal, byte for byte.
      const alias = run(group, "login");
      const canonical = run("secrets", "issue", kind);
      expect(alias.status).toBe(1);
      expect(alias.stdout).toBe(canonical.stdout);
      expect(alias.stderr).toBe(canonical.stderr);

      // It takes nothing: anything else names the full command, on two
      // short lines.
      for (const [extra, instead] of [
        [
          ["widget-key"],
          `Full command: npx hot-updater secrets issue ${kind} --help`,
        ],
        [
          ["--replace"],
          `New key: npx hot-updater secrets issue ${kind} --replace`,
        ],
        [
          ["--json"],
          `Full command: npx hot-updater secrets issue ${kind} --help`,
        ],
      ] as const) {
        const refused = run(group, "login", ...extra);
        expect(refused.status).toBe(1);
        expect(refusal(refused)).toEqual([
          `${group} login takes no options or arguments.`,
          instead,
        ]);
      }
    },
  );

  it.each([
    [
      ["testflight"],
      "ios",
      "testflight",
      "Shortcut for hot-updater native-build ios --submit\\s+testflight",
      "run apple login once first",
    ],
    [
      ["google-play", "upload"],
      "android",
      "play-internal",
      "Shortcut for hot-updater native-build android\\s+--submit\\s+play-internal",
      "and lists everything missing",
    ],
  ] as const)(
    "has %j as the shortcut for native-build %s --submit %s, taking only --scheme",
    (command, platform, destination, summary, nextStep) => {
      const parent = command.length === 1 ? help() : help(command[0]);
      expect(parent).toMatch(
        new RegExp(`^\\s+${command.at(-1)} \\[options\\]\\s+${summary}`, "m"),
      );
      const shortcut = help(...command);
      const flat = shortcut.replace(/\s+/gu, " ");
      expect(flat).toContain(
        `Shortcut for \`hot-updater native-build ${platform} --scheme <scheme> --submit ${destination}\`.`,
      );
      expect(shortcut).toContain("-s, --scheme <scheme>");
      for (const removed of [
        "--json",
        "--output-path",
        "--dry-run",
        "--untracked",
        "--no-register",
        "--submit <destination>",
        "--interactive",
      ]) {
        expect(shortcut).not.toMatch(
          new RegExp(`^\\s+(-\\w, )?${removed}`, "m"),
        );
      }
      expect(flat).toContain(nextStep);

      for (const extra of [
        ["--json"],
        ["--dry-run"],
        ["-o", "out"],
        ["-s", "release", "extra"],
      ]) {
        const refused = run(...command, ...extra);
        expect(refused.status).toBe(1);
        expect(refusal(refused)).toEqual([
          `${command.join(" ")} takes only --scheme.`,
          `Full command: npx hot-updater native-build ${platform} --submit ${destination}`,
        ]);
      }
    },
  );

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
