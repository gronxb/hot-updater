import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAndInjectFingerprintFiles: vi.fn(),
  cwd: "",
  loadConfig: vi.fn(),
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    getCwd: () => mocks.cwd,
    loadConfig: mocks.loadConfig,
    p: {
      ...actual.p,
      spinner: () => mocks.spinner,
      log: { ...actual.p.log, info: mocks.info, warn: mocks.warn },
    },
  };
});

vi.mock("@/utils/fingerprint", () => ({
  createAndInjectFingerprintFiles: mocks.createAndInjectFingerprintFiles,
}));

import { prepareInitFingerprint } from "./initFingerprint";

describe("prepareInitFingerprint", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.cwd = await fs.mkdtemp(path.join(os.tmpdir(), "init-fingerprint-"));
    mocks.createAndInjectFingerprintFiles.mockResolvedValue({
      fingerprint: {},
    });
  });

  afterEach(async () => {
    await fs.rm(mocks.cwd, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("creates fingerprint.json for a fingerprint project without one, and says to commit it", async () => {
    mocks.loadConfig.mockResolvedValue({ updateStrategy: "fingerprint" });

    await expect(prepareInitFingerprint()).resolves.toEqual([]);

    expect(mocks.loadConfig).toHaveBeenCalledWith(null);
    expect(mocks.createAndInjectFingerprintFiles).toHaveBeenCalledOnce();
    expect(mocks.spinner.stop).toHaveBeenCalledWith("Created fingerprint.json");
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("Commit fingerprint.json"),
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("leaves an appVersion project alone", async () => {
    mocks.loadConfig.mockResolvedValue({ updateStrategy: "appVersion" });

    await expect(prepareInitFingerprint()).resolves.toEqual([]);

    expect(mocks.createAndInjectFingerprintFiles).not.toHaveBeenCalled();
    expect(mocks.spinner.start).not.toHaveBeenCalled();
  });

  it("keeps the fingerprint.json a project already has, as when init replays", async () => {
    mocks.loadConfig.mockResolvedValue({ updateStrategy: "fingerprint" });
    await fs.writeFile(path.join(mocks.cwd, "fingerprint.json"), "{}");

    await expect(prepareInitFingerprint()).resolves.toEqual([]);

    expect(mocks.createAndInjectFingerprintFiles).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(mocks.cwd, "fingerprint.json"), "utf8"),
    ).resolves.toBe("{}");
  });

  it("returns the one next step, without failing init, when it can't fingerprint", async () => {
    mocks.loadConfig.mockResolvedValue({ updateStrategy: "fingerprint" });
    mocks.createAndInjectFingerprintFiles.mockRejectedValue(
      new Error("no native project"),
    );

    await expect(prepareInitFingerprint()).resolves.toEqual([
      "npx hot-updater fingerprint create",
    ]);

    expect(mocks.spinner.error).toHaveBeenCalledWith(
      "Creating fingerprint.json failed: no native project",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves a config that doesn't load to doctor, without failing init", async () => {
    mocks.loadConfig.mockRejectedValue(new Error("bad config"));

    await expect(prepareInitFingerprint()).resolves.toEqual([
      "npx hot-updater doctor",
    ]);

    expect(mocks.createAndInjectFingerprintFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
