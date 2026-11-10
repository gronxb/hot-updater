import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FingerprintFile } from "./common";
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

describe("syncFingerprintFiles compares the data fingerprint.json records", () => {
  const recorded: FingerprintFile = {
    ios: {
      engine: "hot-updater/interface@1",
      hash: "ios-now",
      sources: [
        {
          type: "contents" as const,
          id: "dependency:react-native-screens",
          contents: "react-native-screens@4.30.1",
          reasons: ["native-dependency"],
          hash: "screens",
        },
      ],
    },
    android: {
      engine: "hot-updater/interface@1",
      hash: "android-now",
      sources: [],
    },
    inputs: { adapter: "bare", extraSources: ["native/**"], nativeVersion: 1 },
  };

  it("writes nothing when only the order of the inputs' keys differs", async () => {
    const before = JSON.stringify({
      ...recorded,
      inputs: {
        nativeVersion: 1,
        extraSources: ["native/**"],
        adapter: "bare",
      },
    });
    await fs.writeFile(path.join(project, "fingerprint.json"), before);

    await expect(syncFingerprintFiles(recorded)).resolves.toEqual({
      fingerprintJson: false,
    });
    expect(
      await fs.readFile(path.join(project, "fingerprint.json"), "utf8"),
    ).toBe(before);
  });

  it("writes fingerprint.json when a source's contents differ under the same hashes", async () => {
    await writeFingerprintJson({
      ...recorded,
      ios: {
        ...recorded.ios,
        sources: [{ ...recorded.ios.sources[0], contents: "edited by hand" }],
      },
    });

    await expect(syncFingerprintFiles(recorded)).resolves.toEqual({
      fingerprintJson: true,
    });
    expect(await readFingerprintJson()).toEqual(recorded);
  });

  it("writes fingerprint.json when a source is missing under the same hashes", async () => {
    await writeFingerprintJson({
      ...recorded,
      ios: { ...recorded.ios, sources: [] },
    });

    await expect(syncFingerprintFiles(recorded)).resolves.toEqual({
      fingerprintJson: true,
    });
  });

  it.each([
    ["nativeVersion as a string", { ...recorded.inputs, nativeVersion: "1" }],
    [
      "empty extraSources",
      { adapter: "bare", extraSources: [], nativeVersion: 1 },
    ],
    ["no extraSources", { adapter: "bare", nativeVersion: 1 }],
    [
      "per-platform extraSources",
      {
        adapter: "bare",
        extraSources: { ios: ["native/**"], android: ["native/**"] },
        nativeVersion: 1,
      },
    ],
  ])("writes fingerprint.json when it records %s", async (_, inputs) => {
    await writeFingerprintJson({ ...recorded, inputs });

    await expect(syncFingerprintFiles(recorded)).resolves.toEqual({
      fingerprintJson: true,
    });
    expect(await readFingerprintJson()).toEqual(recorded);
  });

  it("writes fingerprint.json when it records no engine", async () => {
    const { engine: _engine, ...ios } = recorded.ios;
    await writeFingerprintJson({ ...recorded, ios });

    await expect(syncFingerprintFiles(recorded)).resolves.toEqual({
      fingerprintJson: true,
    });
  });
});
