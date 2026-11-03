import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkExpoSdk } from "./expoSdk";

let root: string;

const write = (file: string, contents: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(contents));
};

const config = (adapter: string) =>
  ({ build: async () => ({ name: adapter }) }) as unknown as ConfigResponse;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-expo-sdk-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkExpoSdk", () => {
  it("reports an Expo project below the minimum, with one next step", async () => {
    write("package.json", { dependencies: { expo: "~54.0.38" } });

    expect(await checkExpoSdk(config("expo"), root)).toEqual([
      {
        type: "error",
        platform: "project",
        code: "EXPO_SDK_UNSUPPORTED",
        message:
          "Hot Updater requires Expo SDK 55 or later. This project uses SDK 54.",
        resolution: "Run `npx expo install expo@^55.0.0 --fix`.",
        commands: ["npx expo install expo@^55.0.0 --fix"],
      },
    ]);
  });

  it("takes the minimum and every later SDK", async () => {
    for (const expo of ["~55.0.32", "^56.0.0", "~58.0.22"]) {
      write("package.json", { devDependencies: { expo } });
      expect(await checkExpoSdk(config("expo"), root)).toEqual([]);
    }
  });

  it("says nothing without an Expo version to read", async () => {
    write("package.json", {});
    expect(await checkExpoSdk(config("expo"), root)).toEqual([]);
  });

  it("reads the installed SDK over a range that allows it", async () => {
    write("package.json", { dependencies: { expo: ">=50.0.0" } });
    write("node_modules/expo/package.json", { version: "55.0.32" });
    expect(await checkExpoSdk(config("expo"), root)).toEqual([]);
  });

  it("reads the installed SDK, not digits in a catalog name", async () => {
    write("package.json", { dependencies: { expo: "catalog:sdk55" } });
    write("node_modules/expo/package.json", { version: "54.0.38" });
    expect(await checkExpoSdk(config("expo"), root)).toEqual([
      expect.objectContaining({ code: "EXPO_SDK_UNSUPPORTED" }),
    ]);
  });

  it("leaves another build adapter's Expo dependency alone", async () => {
    write("package.json", { dependencies: { expo: "~52.0.49" } });
    expect(await checkExpoSdk(config("bare"), root)).toEqual([]);
  });

  it("reads the installed SDK over a range that allows it", async () => {
    write("package.json", { dependencies: { expo: ">=50.0.0" } });
    write("node_modules/expo/package.json", { version: "55.0.32" });
    expect(await checkExpoSdk(config("expo"), root)).toEqual([]);
  });

  it("reads the installed SDK, not digits in a catalog name", async () => {
    write("package.json", { dependencies: { expo: "catalog:sdk55" } });
    write("node_modules/expo/package.json", { version: "54.0.38" });
    expect(await checkExpoSdk(config("expo"), root)).toEqual([
      expect.objectContaining({ code: "EXPO_SDK_UNSUPPORTED" }),
    ]);
  });

  it("leaves another build adapter's Expo dependency alone", async () => {
    write("package.json", { dependencies: { expo: "~52.0.49" } });
    expect(await checkExpoSdk(config("bare"), root)).toEqual([]);
  });
});
