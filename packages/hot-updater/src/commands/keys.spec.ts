import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  androidExists: vi.fn(),
  androidGet: vi.fn(),
  androidSet: vi.fn(),
  getCwd: vi.fn(),
  iosExists: vi.fn(),
  iosGet: vi.fn(),
  iosSet: vi.fn(),
  isCancel: vi.fn(() => false),
  loadConfig: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logMessage: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  getBundleSigningPublicKey: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).getBundleSigningPublicKey,
  colors: {
    blue: (value: string) => value,
    bold: (value: string) => value,
    cyan: (value: string) => value,
    dim: (value: string) => value,
    green: (value: string) => value,
    magenta: (value: string) => value,
    red: (value: string) => value,
    yellow: (value: string) => value,
  },
  getCwd: mocks.getCwd,
  loadConfig: mocks.loadConfig,
  p: {
    cancel: mocks.cancel,
    confirm: mocks.confirm,
    isCancel: mocks.isCancel,
    log: {
      error: mocks.logError,
      info: mocks.logInfo,
      message: mocks.logMessage,
      success: mocks.logSuccess,
      warn: mocks.logWarn,
    },
  },
}));

vi.mock("@/utils/configParser/androidParser", () => ({
  AndroidConfigParser: class {
    exists = mocks.androidExists;
    get = mocks.androidGet;
    set = mocks.androidSet;
  },
}));

vi.mock("@/utils/configParser/iosParser", () => ({
  IosConfigParser: class {
    exists = mocks.iosExists;
    get = mocks.iosGet;
    set = mocks.iosSet;
  },
}));

vi.mock("@/utils/expoDetection", () => ({
  warnIfExpoCNG: vi.fn(),
}));

vi.mock("@/utils/git", () => ({
  appendToProjectRootGitignore: vi.fn(),
}));

vi.mock("@/utils/signing", () => ({
  generateKeyPair: vi.fn(),
  getPrivateKeyGitignorePath: vi.fn(),
  getPublicKeyFromPrivate: vi.fn(),
  loadPrivateKey: vi.fn(),
  saveKeyPair: vi.fn(),
}));

import { keysExportPublic } from "./keys";

const tempProjects: string[] = [];

const createKeyPair = () =>
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

const createProject = async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keys-export-public-"));
  tempProjects.push(cwd);
  return cwd;
};

const configureProject = async (cwd: string, publicKey: string) => {
  await fs.mkdir(path.join(cwd, "keys"), { recursive: true });
  await fs.writeFile(path.join(cwd, "keys/public-key.pem"), publicKey);
  mocks.getCwd.mockReturnValue(cwd);
  mocks.loadConfig.mockResolvedValue({
    signing: {
      name: "test-signing",
      publicKeyPath: "keys/public-key.pem",
      getPublicKey: vi.fn(),
      sign: vi.fn(),
    },
    platform: {
      android: {
        androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
      },
      ios: { infoPlistPaths: [] },
    },
  });
};

describe("keysExportPublic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCancel.mockReturnValue(false);
    mocks.androidExists.mockResolvedValue(true);
    mocks.iosExists.mockResolvedValue(false);
    mocks.iosGet.mockResolvedValue({ value: null, paths: [] });
    mocks.androidSet.mockResolvedValue({
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempProjects
        .splice(0)
        .map((project) => fs.rm(project, { force: true, recursive: true })),
    );
  });

  it("defaults to rejecting a native trust-anchor change", async () => {
    const previous = createKeyPair();
    const next = createKeyPair();
    const cwd = await createProject();
    await configureProject(cwd, next.publicKey);
    mocks.androidGet.mockResolvedValue({
      value: previous.publicKey.trim().replaceAll("\n", "\\n"),
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });
    mocks.confirm.mockResolvedValue(false);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process exit");
    });

    await expect(keysExportPublic()).rejects.toThrow("process exit");

    expect(mocks.confirm).toHaveBeenCalledWith({
      message: "Replace the existing public key?",
      initialValue: false,
    });
    expect(mocks.logMessage).toHaveBeenCalledWith(
      expect.stringContaining("sha256:"),
    );
    expect(mocks.androidSet).not.toHaveBeenCalled();
  });

  it("keeps the normal confirmation for the same canonical public key", async () => {
    const keyPair = createKeyPair();
    const cwd = await createProject();
    await configureProject(cwd, keyPair.publicKey);
    mocks.androidGet.mockResolvedValue({
      value: keyPair.publicKey.trim().replaceAll("\n", "\\n"),
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });
    mocks.confirm.mockResolvedValue(false);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process exit");
    });

    await expect(keysExportPublic()).rejects.toThrow("process exit");

    expect(mocks.confirm).toHaveBeenCalledWith({
      message: "Write public key?",
      initialValue: true,
    });
  });

  it("treats --yes as an explicit trust-anchor replacement", async () => {
    const previous = createKeyPair();
    const next = createKeyPair();
    const cwd = await createProject();
    await configureProject(cwd, next.publicKey);
    mocks.androidGet.mockResolvedValue({
      value: previous.publicKey,
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });

    await keysExportPublic({ yes: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.androidSet).toHaveBeenCalledWith(
      "hot_updater_public_key",
      next.publicKey.trim(),
    );
  });

  it("exports the public key from unchanged v0 local config without a public file", async () => {
    const { privateKey, publicKey } = createKeyPair();
    const cwd = await createProject();
    await fs.writeFile(path.join(cwd, "private.pem"), privateKey);
    mocks.getCwd.mockReturnValue(cwd);
    mocks.loadConfig.mockResolvedValue({
      signing: { enabled: true, privateKeyPath: "private.pem" },
      platform: {
        android: {
          androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
        },
        ios: { infoPlistPaths: [] },
      },
    });
    mocks.androidGet.mockResolvedValue({ value: null, paths: [] });
    await keysExportPublic({ yes: true });
    expect(mocks.androidSet).toHaveBeenCalledWith(
      "hot_updater_public_key",
      publicKey.trim(),
    );
  });
});
