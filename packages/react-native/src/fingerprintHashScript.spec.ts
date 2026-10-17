import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const script = join(packageRoot, "ios/scripts/generate-fingerprint-hash.zsh");
const zsh = "/bin/zsh";

const directories: string[] = [];

const readPackageFile = (path: string) =>
  readFileSync(join(packageRoot, path), "utf8");

const makeDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "hot-updater-fingerprint-"));
  directories.push(directory);
  return directory;
};

/**
 * An app root with fingerprint.json and a hot-updater CLI whose
 * `fingerprint hash` prints what a Release build would compute.
 */
const makeApp = ({
  withFingerprintJson = true,
  cliSource = "console.log(`computed:${process.argv.slice(2).join(' ')}`);",
} = {}) => {
  const app = makeDirectory();
  writeFileSync(join(app, "package.json"), "{}");
  if (withFingerprintJson) {
    writeFileSync(
      join(app, "fingerprint.json"),
      JSON.stringify({
        ios: { hash: "recorded-ios" },
        android: { hash: "recorded-android" },
      }),
    );
  }
  const cli = join(app, "node_modules/hot-updater");
  mkdirSync(cli, { recursive: true });
  writeFileSync(
    join(cli, "package.json"),
    JSON.stringify({ name: "hot-updater", bin: { "hot-updater": "cli.js" } }),
  );
  writeFileSync(join(cli, "cli.js"), cliSource);
  return app;
};

const run = (args: string[], env: Record<string, string>) => {
  const {
    HOT_UPDATER_APP_ROOT: _root,
    CONFIGURATION: _configuration,
    PODS_ROOT: _pods,
    ...inherited
  } = process.env;
  execFileSync(zsh, [script, ...args], {
    env: { ...inherited, NODE_BINARY: process.execPath, ...env },
    stdio: "pipe",
  });
};

// What the podspec's script phase writes for HotUpdaterFingerprintHash.m.
const runScriptPhase = (app: string, configuration: string) => {
  const derivedFileDir = makeDirectory();
  run([], {
    DERIVED_FILE_DIR: derivedFileDir,
    PODS_ROOT: join(app, "ios/Pods"),
    CONFIGURATION: configuration,
  });
  const header = readFileSync(
    join(derivedFileDir, "HotUpdaterBuildFingerprintHash.h"),
    "utf8",
  );
  return /^#define HOT_UPDATER_BUILD_FINGERPRINT_HASH "([^"]*)"\n$/.exec(
    header,
  )?.[1];
};

// What Package.swift's build tool plugin writes into the HotUpdaterSwift target.
const runBuildToolPlugin = (app: string, env: Record<string, string> = {}) => {
  const outputDirectory = makeDirectory();
  run(["--swift", outputDirectory, app], env);
  const source = readFileSync(
    join(outputDirectory, "HotUpdaterBuildFingerprintHash.swift"),
    "utf8",
  );
  expect(source).toContain('@_cdecl("HotUpdaterBuildFingerprintHash")');
  return /^ {4}"([^"]*)"$/m.exec(source)?.[1];
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("iOS fingerprint generation", () => {
  it("is the script the podspec runs before every compile", () => {
    const podspec = readPackageFile("HotUpdater.podspec");

    expect(podspec).toContain('"ios/scripts/generate-fingerprint-hash.zsh"');
    expect(podspec).toContain(
      '"$(DERIVED_FILE_DIR)/HotUpdaterBuildFingerprintHash.h"',
    );
  });

  it("is the script Package.swift's prebuild plugin runs every build", () => {
    const manifest = readPackageFile("Package.swift");
    const plugin = readPackageFile(
      "ios/Plugins/HotUpdaterFingerprintPlugin/HotUpdaterFingerprintPlugin.swift",
    );

    expect(manifest).toMatch(/plugins: \[[^\]]*"HotUpdaterFingerprintPlugin"/);
    expect(plugin).toContain('"ios/scripts/generate-fingerprint-hash.zsh"');
    expect(plugin).toContain('"HOT_UPDATER_APP_ROOT"');
  });

  it.skipIf(!existsSync(zsh))(
    "computes the fingerprint in a Release build",
    () => {
      expect(runScriptPhase(makeApp(), "Release")).toBe(
        "computed:fingerprint hash -p ios",
      );
    },
  );

  it.skipIf(!existsSync(zsh))(
    "lets the CLI spawn npm's tools beside node under Xcode's minimal PATH",
    () => {
      // Rock's adapter runs `npx rock config`; npx sits beside node.
      const app = makeApp({
        cliSource: `console.log(require("node:child_process").execFileSync("${basename(process.execPath)}", ["-p", "'beside node'"], { encoding: "utf8" }).trim());`,
      });
      const derivedFileDir = makeDirectory();
      run([], {
        DERIVED_FILE_DIR: derivedFileDir,
        PODS_ROOT: join(app, "ios/Pods"),
        CONFIGURATION: "Release",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      });

      expect(
        readFileSync(
          join(derivedFileDir, "HotUpdaterBuildFingerprintHash.h"),
          "utf8",
        ),
      ).toContain('"beside node"');
    },
  );

  it.skipIf(!existsSync(zsh))(
    "embeds the recorded fingerprint in a Debug build",
    () => {
      expect(runScriptPhase(makeApp(), "Debug")).toBe("recorded-ios");
    },
  );

  it.skipIf(!existsSync(zsh))(
    "embeds no fingerprint for an app without fingerprint.json",
    () => {
      expect(
        runScriptPhase(makeApp({ withFingerprintJson: false }), "Release"),
      ).toBe("");
    },
  );

  it.skipIf(!existsSync(zsh))(
    "takes the app root from the build tool plugin, or HOT_UPDATER_APP_ROOT over it",
    () => {
      const app = makeApp();
      const other = makeApp({ withFingerprintJson: false });

      expect(runBuildToolPlugin(app)).toBe("computed:fingerprint hash -p ios");
      expect(runBuildToolPlugin(other, { HOT_UPDATER_APP_ROOT: app })).toBe(
        "computed:fingerprint hash -p ios",
      );
    },
  );
});
