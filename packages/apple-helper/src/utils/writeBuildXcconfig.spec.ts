import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSettingsOverScheme,
  writeBuildXcconfig,
} from "./writeBuildXcconfig";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-xc-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const write = (name: string, contents: string) =>
  fs.writeFile(path.join(directory, name), contents);

describe("writeBuildXcconfig", () => {
  it("includes the scheme's xcconfigs, then sets each setting for every SDK", async () => {
    await write("Release.xcconfig", "CODE_SIGN_STYLE = Manual\n");

    const { xcconfig, extraParams } = await writeBuildXcconfig({
      directory,
      sourceDir: directory,
      xcconfig: "Release.xcconfig",
      extraParams: ["-quiet"],
      settings: { HOT_UPDATER_MIN_BUNDLE_ID: "id" },
    });

    expect(extraParams).toEqual(["-quiet"]);
    await expect(fs.readFile(xcconfig, "utf-8")).resolves.toBe(
      `#include "${path.join(directory, "Release.xcconfig")}"
HOT_UPDATER_MIN_BUNDLE_ID = id
HOT_UPDATER_MIN_BUNDLE_ID[sdk=iphoneos*] = id
HOT_UPDATER_MIN_BUNDLE_ID[sdk=iphonesimulator*] = id
`,
    );
  });

  it("refuses a setting an included xcconfig sets with a condition it does not set, which would outrank its own", async () => {
    await write("Release.xcconfig", '#include "Signing.xcconfig"\n');
    await write(
      "Signing.xcconfig",
      "CODE_SIGN_STYLE[sdk=iphoneos*] = Manual\nCODE_SIGN_STYLE[sdk=iphoneos*][config=Release] = Manual\n",
    );

    await expect(
      writeBuildXcconfig({
        directory,
        sourceDir: directory,
        xcconfig: "Release.xcconfig",
        settings: { CODE_SIGN_STYLE: "Automatic" },
      }),
    ).rejects.toThrow(
      `${path.join(directory, "Signing.xcconfig")}:2 sets CODE_SIGN_STYLE[sdk=iphoneos*][config=Release], which would outrank the value the build sets.`,
    );
  });

  it("refuses a sandbox scheme's condition setting that would outrank the build's", async () => {
    await write(
      "Release.xcconfig",
      "GCC_PREPROCESSOR_DEFINITIONS[config=Release] = RELEASE=1\n",
    );

    await expect(
      writeBuildXcconfig({
        directory,
        sourceDir: directory,
        xcconfig: "Release.xcconfig",
        settings: buildSettingsOverScheme({
          minBundleId: "id",
          sandbox: true,
        }),
      }),
    ).rejects.toThrow(
      `${path.join(directory, "Release.xcconfig")}:1 sets GCC_PREPROCESSOR_DEFINITIONS[config=Release]`,
    );
  });

  it("keeps what a scheme's xcconfig sets for the conditions without a condition", async () => {
    await write(
      "Release.xcconfig",
      "SWIFT_ACTIVE_COMPILATION_CONDITIONS = APP\nGCC_PREPROCESSOR_DEFINITIONS = APP=1\n",
    );

    const { xcconfig } = await writeBuildXcconfig({
      directory,
      sourceDir: directory,
      xcconfig: "Release.xcconfig",
      settings: buildSettingsOverScheme({ minBundleId: "id", sandbox: true }),
    });

    const written = await fs.readFile(xcconfig, "utf-8");
    expect(written).toContain(
      "SWIFT_ACTIVE_COMPILATION_CONDITIONS = $(inherited) HOT_UPDATER_SANDBOX_LAYER\n",
    );
    expect(written).toContain(
      "GCC_PREPROCESSOR_DEFINITIONS = $(inherited) HOT_UPDATER_SANDBOX_LAYER=1\n",
    );
    expect(written.indexOf("#include")).toBeLessThan(
      written.indexOf("SWIFT_ACTIVE_COMPILATION_CONDITIONS"),
    );
  });

  it("keeps a conditional setting of a key it does not set", async () => {
    await write(
      "Release.xcconfig",
      "CODE_SIGN_STYLE[config=Release] = Manual\nOTHER_SWIFT_FLAGS[arch=arm64] = -DARM\n",
    );

    await expect(
      writeBuildXcconfig({
        directory,
        sourceDir: directory,
        xcconfig: "Release.xcconfig",
        settings: { HOT_UPDATER_MIN_BUNDLE_ID: "id" },
      }),
    ).resolves.toMatchObject({ extraParams: [] });
  });
});
