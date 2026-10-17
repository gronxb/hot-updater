import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeRecordedFingerprintHash } from "./recorded";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
}));

let project: string;

beforeEach(async () => {
  project = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-recorded-")),
  );
  vi.mocked(getCwd).mockReturnValue(project);
  await fs.writeFile(path.join(project, "package.json"), "{}");
  // A bare adapter whose fingerprint echoes what it receives.
  const bare = path.join(project, "node_modules/@hot-updater/bare");
  await fs.mkdir(bare, { recursive: true });
  await fs.writeFile(
    path.join(bare, "package.json"),
    JSON.stringify({ name: "@hot-updater/bare", main: "index.js" }),
  );
  await fs.writeFile(
    path.join(bare, "index.js"),
    "exports.bareFingerprint = async (cwd, options) => ({ hash: `computed:${options.platform}:${options.nativeVersion}:${JSON.stringify(options.extraSources)}`, sources: [] });",
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(project, { recursive: true, force: true });
});

const writeFingerprintJson = (value: unknown) =>
  fs.writeFile(path.join(project, "fingerprint.json"), JSON.stringify(value));

describe("computeRecordedFingerprintHash", () => {
  it("computes the fingerprint with the recorded adapter and inputs", async () => {
    await writeFingerprintJson({
      ios: { hash: "recorded-ios", sources: [] },
      android: { hash: "recorded-android", sources: [] },
      inputs: { adapter: "bare", extraSources: ["config"], nativeVersion: 2 },
    });

    await expect(computeRecordedFingerprintHash("ios")).resolves.toEqual({
      hash: 'computed:ios:2:["config"]',
      recorded: "recorded-ios",
    });
  });

  it("embeds the recorded hash with a warning when fingerprint.json records no inputs", async () => {
    await writeFingerprintJson({
      ios: { hash: "recorded-ios", sources: [] },
      android: { hash: "recorded-android", sources: [] },
    });

    await expect(computeRecordedFingerprintHash("android")).resolves.toEqual({
      hash: "recorded-android",
      recorded: "recorded-android",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("records no inputs"),
    );
  });

  it("embeds the recorded hash with a warning for an adapter that needs the config", async () => {
    await writeFingerprintJson({
      ios: { hash: "recorded-ios", sources: [] },
      android: { hash: "recorded-android", sources: [] },
      inputs: { adapter: "custom" },
    });

    await expect(computeRecordedFingerprintHash("ios")).resolves.toEqual({
      hash: "recorded-ios",
      recorded: "recorded-ios",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"custom" build adapter'),
    );
  });

  it("embeds the recorded hash with a warning for an adapter version without the export", async () => {
    await fs.writeFile(
      path.join(project, "node_modules/@hot-updater/bare/index.js"),
      "exports.bare = () => ({});",
    );
    await writeFingerprintJson({
      ios: { hash: "recorded-ios", sources: [] },
      android: { hash: "recorded-android", sources: [] },
      inputs: { adapter: "bare" },
    });

    await expect(computeRecordedFingerprintHash("ios")).resolves.toEqual({
      hash: "recorded-ios",
      recorded: "recorded-ios",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("does not export bareFingerprint"),
    );
  });

  it("fails without fingerprint.json", async () => {
    await expect(computeRecordedFingerprintHash("ios")).rejects.toThrow(
      "fingerprint.json was not found",
    );
  });
});
