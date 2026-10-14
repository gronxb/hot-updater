import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const script = join(packageRoot, "ios/scripts/generate-min-bundle-id.zsh");
const zsh = "/bin/zsh";

const directories: string[] = [];

const runScript = (env: Record<string, string> = {}) => {
  const derivedFileDir = mkdtempSync(join(tmpdir(), "hot-updater-min-id-"));
  directories.push(derivedFileDir);
  const { HOT_UPDATER_MIN_BUNDLE_ID: _, ...inherited } = process.env;
  execFileSync(zsh, [script], {
    env: { ...inherited, DERIVED_FILE_DIR: derivedFileDir, ...env },
    stdio: "pipe",
  });
  const header = readFileSync(
    join(derivedFileDir, "HotUpdaterBuildMinBundleId.h"),
    "utf8",
  );
  return /^#define HOT_UPDATER_BUILD_MIN_BUNDLE_ID "([^"]+)"\n$/.exec(
    header,
  )?.[1];
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("iOS MIN_BUNDLE_ID script phase", () => {
  it("is the script the podspec runs before every compile", () => {
    const podspec = readFileSync(
      join(packageRoot, "HotUpdater.podspec"),
      "utf8",
    );

    expect(podspec).toContain('"ios/scripts/generate-min-bundle-id.zsh"');
    expect(podspec).toContain(":execution_position => :before_compile");
    expect(podspec).toContain(':always_out_of_date => "1"');
    expect(podspec).toContain(
      '"$(DERIVED_FILE_DIR)/HotUpdaterBuildMinBundleId.h"',
    );
  });

  it.skipIf(!existsSync(zsh))(
    "writes the build time as a UUIDv7 with zeroed random bits",
    () => {
      const before = Date.now();
      const id = runScript();
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
    "keeps the HOT_UPDATER_MIN_BUNDLE_ID build setting the CLI passes",
    () => {
      expect(
        runScript({
          HOT_UPDATER_MIN_BUNDLE_ID: "019A2B3C-4D5E-7000-8000-000000000000",
        }),
      ).toBe("019a2b3c-4d5e-7000-8000-000000000000");
    },
  );

  it.skipIf(!existsSync(zsh))(
    "fails the build on a build setting that is not a UUIDv7",
    () => {
      expect(() =>
        runScript({ HOT_UPDATER_MIN_BUNDLE_ID: "not-a-uuid" }),
      ).toThrow();
    },
  );
});
