import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const script = join(packageRoot, "ios/scripts/generate-min-bundle-id.zsh");
const zsh = "/bin/zsh";

const directories: string[] = [];

const readPackageFile = (path: string) =>
  readFileSync(join(packageRoot, path), "utf8");

const makeDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "hot-updater-min-id-"));
  directories.push(directory);
  return directory;
};

const run = (args: string[], env: Record<string, string>) => {
  const { HOT_UPDATER_MIN_BUNDLE_ID: _, ...inherited } = process.env;
  execFileSync(zsh, [script, ...args], {
    env: { ...inherited, ...env },
    stdio: "pipe",
  });
};

// What the podspec's script phase writes for HotUpdaterMinBundleId.m.
const runScriptPhase = (env: Record<string, string> = {}) => {
  const derivedFileDir = makeDirectory();
  run([], { DERIVED_FILE_DIR: derivedFileDir, ...env });
  const header = readFileSync(
    join(derivedFileDir, "HotUpdaterBuildMinBundleId.h"),
    "utf8",
  );
  return /^#define HOT_UPDATER_BUILD_MIN_BUNDLE_ID "([^"]+)"\n$/.exec(
    header,
  )?.[1];
};

// What Package.swift's build tool plugin writes into the HotUpdaterSwift target.
const runBuildToolPlugin = (env: Record<string, string> = {}) => {
  const outputDirectory = makeDirectory();
  run(["--swift", outputDirectory], env);
  const source = readFileSync(
    join(outputDirectory, "HotUpdaterBuildMinBundleId.swift"),
    "utf8",
  );
  expect(source).toContain('@_cdecl("HotUpdaterBuildMinBundleId")');
  return /^ {4}"([^"]+)"$/m.exec(source)?.[1];
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("iOS MIN_BUNDLE_ID generation", () => {
  it("is the script the podspec runs before every compile", () => {
    const podspec = readPackageFile("HotUpdater.podspec");

    expect(podspec).toContain('"ios/scripts/generate-min-bundle-id.zsh"');
    expect(podspec).toContain(":execution_position => :before_compile");
    expect(podspec).toContain(':always_out_of_date => "1"');
    expect(podspec).toContain(
      '"$(DERIVED_FILE_DIR)/HotUpdaterBuildMinBundleId.h"',
    );
  });

  it("is the script Package.swift's prebuild plugin runs every build", () => {
    const manifest = readPackageFile("Package.swift");
    const plugin = readPackageFile(
      "ios/Plugins/HotUpdaterMinBundleIdPlugin/HotUpdaterMinBundleIdPlugin.swift",
    );

    expect(manifest).toMatch(/plugins: \[[^\]]*"HotUpdaterMinBundleIdPlugin"/);
    expect(manifest).toContain(
      'path: "ios/Plugins/HotUpdaterMinBundleIdPlugin"',
    );
    expect(plugin).toContain(".prebuildCommand(");
    expect(plugin).toContain('"ios/scripts/generate-min-bundle-id.zsh"');
    expect(plugin).toContain('"--swift"');
    expect(plugin).toContain('environment["HOT_UPDATER_MIN_BUNDLE_ID"]');
  });

  describe.each([
    ["podspec script phase", runScriptPhase],
    ["Package.swift build tool plugin", runBuildToolPlugin],
  ])("%s", (_, generate) => {
    it.skipIf(!existsSync(zsh))(
      "writes the build time as a UUIDv7 with zeroed random bits",
      () => {
        const before = Date.now();
        const id = generate();
        const after = Date.now();

        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/);
        const timestamp = Number.parseInt(
          id!.replaceAll("-", "").slice(0, 12),
          16,
        );
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
      },
    );

    it.skipIf(!existsSync(zsh))(
      "keeps the HOT_UPDATER_MIN_BUNDLE_ID the CLI passes",
      () => {
        expect(
          generate({
            HOT_UPDATER_MIN_BUNDLE_ID: "019A2B3C-4D5E-7000-8000-000000000000",
          }),
        ).toBe("019a2b3c-4d5e-7000-8000-000000000000");
      },
    );

    it.skipIf(!existsSync(zsh))(
      "fails the build on a value that is not a UUIDv7",
      () => {
        expect(() =>
          generate({ HOT_UPDATER_MIN_BUNDLE_ID: "not-a-uuid" }),
        ).toThrow();
      },
    );
  });
});

describe("Swift Package Manager manifest", () => {
  it("is found by React Native's SwiftPM autolinking under its spm.name", () => {
    const config = readPackageFile("react-native.config.js");
    const manifest = readPackageFile("Package.swift");
    const { files } = JSON.parse(readPackageFile("package.json")) as {
      files: string[];
    };

    expect(config).toContain('name: "HotUpdater"');
    expect(manifest).toContain('name: "HotUpdater"');
    expect(manifest).toContain(
      '.library(name: "HotUpdater", targets: ["HotUpdater"])',
    );
    expect(files).toEqual(
      expect.arrayContaining(["Package.swift", "react-native.config.js"]),
    );
  });
});
