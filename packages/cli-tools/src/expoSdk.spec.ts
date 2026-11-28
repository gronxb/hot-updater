import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSupportedExpoSdk,
  MINIMUM_EXPO_SDK,
  readExpoSdk,
} from "./expoSdk";

let root: string;

const write = (file: string, contents: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(contents));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tools-expo-sdk-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readExpoSdk", () => {
  it("reads the installed expo before the declared range", () => {
    write("package.json", { dependencies: { expo: ">=50.0.0" } });
    write("node_modules/expo/package.json", { version: "55.0.32" });
    expect(readExpoSdk(root)).toEqual({
      sdk: 55,
      version: "55.0.32",
      installed: true,
    });
  });

  it("finds expo hoisted above the project, as Node does", () => {
    write("node_modules/expo/package.json", { version: "54.0.38" });
    const app = path.join(root, "apps", "mobile");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ dependencies: { expo: "catalog:" } }),
    );
    expect(readExpoSdk(app)?.sdk).toBe(54);
  });

  it("falls back to the lowest version a declared range allows", () => {
    for (const [range, version] of [
      ["~55.0.32", "55.0.32"],
      ["^54.0.0", "54.0.0"],
      [">=50.0.0", "50.0.0"],
      ["55.x", "55.0.0"],
    ]) {
      write("package.json", { devDependencies: { expo: range } });
      expect(readExpoSdk(root), range).toEqual({
        sdk: Number.parseInt(version, 10),
        version,
        installed: false,
      });
    }
  });

  it("takes no version from a range that names none", () => {
    for (const range of [
      "catalog:sdk55",
      "workspace:*",
      "latest",
      "^54 || ^55",
    ]) {
      write("package.json", { dependencies: { expo: range } });
      expect(readExpoSdk(root), range).toBeNull();
    }
    write("package.json", {});
    expect(readExpoSdk(root)).toBeNull();
  });
});

describe("assertSupportedExpoSdk", () => {
  it("refuses an installed SDK below the minimum, with the one command", () => {
    write("package.json", { dependencies: { expo: "catalog:sdk55" } });
    write("node_modules/expo/package.json", { version: "54.0.38" });
    expect(() => assertSupportedExpoSdk(root)).toThrow(
      "Hot Updater requires Expo SDK 55 or later. Run:\nnpx expo install expo@^55.0.0 --fix",
    );
  });

  it("takes the minimum, and a project without Expo installed", () => {
    write("node_modules/expo/package.json", { version: "55.0.0" });
    expect(() => assertSupportedExpoSdk(root)).not.toThrow();
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    write("package.json", { dependencies: { expo: "~54.0.0" } });
    expect(() => assertSupportedExpoSdk(root)).not.toThrow();
  });

  it("states the floor of @hot-updater/expo's peer range", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        fileURLToPath(
          new URL("../../../plugins/expo/package.json", import.meta.url),
        ),
        "utf-8",
      ),
    ) as { peerDependencies: { expo: string } };
    expect(manifest.peerDependencies.expo).toBe(`>=${MINIMUM_EXPO_SDK}.0.0`);
  });
});
