import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAndInjectFingerprintFiles: vi.fn(),
  cwd: "",
  info: vi.fn(),
  showFingerprintDiff: vi.fn(),
  spinner: { start: vi.fn(), stop: vi.fn(), error: vi.fn() },
  success: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    getCwd: () => mocks.cwd,
    p: {
      ...actual.p,
      spinner: () => mocks.spinner,
      log: {
        ...actual.p.log,
        info: mocks.info,
        success: mocks.success,
        warn: mocks.warn,
      },
    },
  };
});

vi.mock("@/utils/expoDetection", () => ({ warnIfExpoCNG: vi.fn() }));

vi.mock("@/utils/fingerprint", () => ({
  computeRecordedFingerprintHash: vi.fn(),
  createAndInjectFingerprintFiles: mocks.createAndInjectFingerprintFiles,
  describeFingerprintEngineChange: vi.fn(),
  ensureFingerprintConfig: vi.fn(async () => ({})),
  getFingerprintEngineChange: () => null,
  isFingerprintEquals: (
    a: { ios?: { hash: string }; android?: { hash: string } } | null,
    b: { ios?: { hash: string }; android?: { hash: string } } | null,
  ) => a?.ios?.hash === b?.ios?.hash && a?.android?.hash === b?.android?.hash,
  // As the real one reads it: null when missing or unreadable.
  readLocalFingerprint: async () => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(mocks.cwd, "fingerprint.json"), "utf8"),
      );
    } catch {
      return null;
    }
  },
}));

vi.mock("@/utils/fingerprint/diff", () => ({
  getFingerprintDiff: vi.fn(async () => ({})),
  showFingerprintDiff: mocks.showFingerprintDiff,
}));

import { handleCreateFingerprint } from "./fingerprint";

const fingerprint = (hash: string) => ({
  ios: { hash: `ios-${hash}`, sources: [] },
  android: { hash: `android-${hash}`, sources: [] },
});

const lines = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.map(([message]) => stripVTControlCharacters(String(message)));

describe("fingerprint create", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fingerprint-create-"));
    // As the writer does: only a change in the recorded data writes.
    mocks.createAndInjectFingerprintFiles.mockImplementation(async () => {
      const next = fingerprint("next");
      const file = path.join(mocks.cwd, "fingerprint.json");
      const before = await fs.readFile(file, "utf8").catch(() => null);
      let same = false;
      try {
        same =
          before !== null &&
          JSON.stringify(JSON.parse(before)) === JSON.stringify(next);
      } catch {
        // Unreadable: rewritten.
      }
      if (!same) await fs.writeFile(file, JSON.stringify(next));
      return { fingerprint: next, written: !same };
    });
  });

  afterEach(async () => {
    await fs.rm(mocks.cwd, { recursive: true, force: true });
  });

  it("says only that it created fingerprint.json, and to commit it, when there was none", async () => {
    await handleCreateFingerprint();

    expect(mocks.spinner.stop).toHaveBeenCalledWith("Created fingerprint.json");
    expect(lines(mocks.info)).toEqual([
      "Commit fingerprint.json. Native builds embed its fingerprint, and deploy targets it.",
    ]);
    expect(lines(mocks.success)).toEqual([]);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.showFingerprintDiff).not.toHaveBeenCalled();
  });

  it("says fingerprint.json changed and to rebuild, when it changes an existing one", async () => {
    await fs.writeFile(
      path.join(mocks.cwd, "fingerprint.json"),
      JSON.stringify(fingerprint("before")),
    );

    await handleCreateFingerprint();

    expect(lines(mocks.spinner.stop)).toEqual(["fingerprint.json changed."]);
    expect(lines(mocks.success)).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledWith(
      "Rebuild the native app to embed the new fingerprint.",
    );
    expect(mocks.showFingerprintDiff).toHaveBeenCalledTimes(2);
    expect(lines(mocks.info)).not.toContain(
      "Commit fingerprint.json. Native builds embed its fingerprint, and deploy targets it.",
    );
  });

  const stops = () => lines(mocks.spinner.stop);
  const writeFingerprintJson = (text: string) =>
    fs.writeFile(path.join(mocks.cwd, "fingerprint.json"), text);
  const conflicted = [
    "<<<<<<< HEAD",
    JSON.stringify(fingerprint("next")),
    "=======",
    JSON.stringify(fingerprint("other")),
    ">>>>>>> other",
  ].join("\n");
  it("says only that fingerprint.json is up to date when it wrote nothing", async () => {
    await writeFingerprintJson(JSON.stringify(fingerprint("next")));

    await handleCreateFingerprint();

    expect(stops()).toEqual(["fingerprint.json is up to date."]);
    expect(lines(mocks.success)).toEqual([]);
    expect(lines(mocks.info)).toEqual([]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("says only that it rewrote an unreadable fingerprint.json, without a rebuild", async () => {
    await writeFingerprintJson(conflicted);

    await handleCreateFingerprint();

    expect(stops()).toEqual([
      "Rewrote fingerprint.json, which wasn't valid JSON.",
    ]);
    expect(lines(mocks.success)).toEqual([]);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.showFingerprintDiff).not.toHaveBeenCalled();
  });
});
