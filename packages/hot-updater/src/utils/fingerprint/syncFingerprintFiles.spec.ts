import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFingerprintHash, setFingerprintHash } from "../setFingerprintHash";
import { syncFingerprintFiles } from "./index";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
}));
vi.mock("../setFingerprintHash", () => ({
  getFingerprintHash: vi.fn(),
  setFingerprintHash: vi.fn(),
}));

const fingerprint = {
  ios: { hash: "ios-now", sources: [] },
  android: { hash: "android-now", sources: [] },
};

let project: string;

beforeEach(async () => {
  vi.clearAllMocks();
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sync-"));
  vi.mocked(getCwd).mockReturnValue(project);
  vi.mocked(setFingerprintHash).mockImplementation(async (platform) => ({
    paths: [platform === "ios" ? "ios/App/Info.plist" : "AndroidManifest.xml"],
  }));
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

const writeFingerprintJson = (value: unknown) =>
  fs.writeFile(path.join(project, "fingerprint.json"), JSON.stringify(value));

describe("syncFingerprintFiles", () => {
  it("writes nothing when fingerprint.json and both native hashes already match", async () => {
    await writeFingerprintJson(fingerprint);
    vi.mocked(getFingerprintHash).mockImplementation(async (platform) => ({
      value: fingerprint[platform].hash,
      paths: [],
    }));

    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: false,
      iosPaths: [],
      androidPaths: [],
    });
    expect(setFingerprintHash).not.toHaveBeenCalled();
  });

  it("writes fingerprint.json and only the native hash that differs", async () => {
    await writeFingerprintJson({
      ios: { hash: "ios-before", sources: [] },
      android: fingerprint.android,
    });
    vi.mocked(getFingerprintHash).mockImplementation(async (platform) => ({
      value: platform === "ios" ? "ios-before" : "android-now",
      paths: [],
    }));

    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: true,
      iosPaths: ["ios/App/Info.plist"],
      androidPaths: [],
    });
    expect(setFingerprintHash).toHaveBeenCalledOnce();
    expect(setFingerprintHash).toHaveBeenCalledWith("ios", "ios-now");
    expect(
      JSON.parse(
        await fs.readFile(path.join(project, "fingerprint.json"), "utf8"),
      ),
    ).toEqual(fingerprint);
  });

  it("leaves a platform without native files alone", async () => {
    vi.mocked(getFingerprintHash).mockImplementation(async (platform) => {
      if (platform === "android") {
        throw new Error("No Android native config files found");
      }
      return { value: null, paths: [] };
    });

    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: true,
      iosPaths: ["ios/App/Info.plist"],
      androidPaths: [],
    });
    expect(setFingerprintHash).toHaveBeenCalledWith("ios", "ios-now");
    expect(setFingerprintHash).not.toHaveBeenCalledWith(
      "android",
      expect.anything(),
    );
  });
});
