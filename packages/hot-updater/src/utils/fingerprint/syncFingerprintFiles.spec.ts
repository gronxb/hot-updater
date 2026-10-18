import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncFingerprintFiles } from "./index";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
}));

const fingerprint = {
  ios: { hash: "ios-now", sources: [] },
  android: { hash: "android-now", sources: [] },
  inputs: { adapter: "bare" },
};

let project: string;

beforeEach(async () => {
  vi.clearAllMocks();
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sync-"));
  vi.mocked(getCwd).mockReturnValue(project);
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

const writeFingerprintJson = (value: unknown) =>
  fs.writeFile(path.join(project, "fingerprint.json"), JSON.stringify(value));

const readFingerprintJson = async () =>
  JSON.parse(await fs.readFile(path.join(project, "fingerprint.json"), "utf8"));

describe("syncFingerprintFiles", () => {
  it("writes nothing when fingerprint.json already matches", async () => {
    await writeFingerprintJson(fingerprint);

    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: false,
    });
  });

  it("writes fingerprint.json when a hash differs", async () => {
    await writeFingerprintJson({
      ...fingerprint,
      ios: { hash: "ios-before", sources: [] },
    });

    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: true,
    });
    expect(await readFingerprintJson()).toEqual(fingerprint);
  });

  it("writes fingerprint.json when only the recorded inputs differ", async () => {
    await writeFingerprintJson({
      ios: fingerprint.ios,
      android: fingerprint.android,
    });

    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: true,
    });
    expect(await readFingerprintJson()).toEqual(fingerprint);
  });

  it("records the engine in a fingerprint.json from before engines were recorded", async () => {
    await writeFingerprintJson(fingerprint);
    const withEngine = {
      ...fingerprint,
      ios: { ...fingerprint.ios, engine: "@expo/fingerprint@0.21.5" },
      android: { ...fingerprint.android, engine: "@expo/fingerprint@0.21.5" },
    };

    await expect(syncFingerprintFiles(withEngine)).resolves.toEqual({
      fingerprintJson: true,
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(project, "fingerprint.json"), "utf8"),
      ),
    ).toEqual(withEngine);
  });

  it("creates fingerprint.json when there is none", async () => {
    await expect(syncFingerprintFiles(fingerprint)).resolves.toEqual({
      fingerprintJson: true,
    });
    expect(await readFingerprintJson()).toEqual(fingerprint);
  });
});
