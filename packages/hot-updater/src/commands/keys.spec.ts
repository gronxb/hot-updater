import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { p } from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import {
  displayColumns,
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
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
  logStep: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
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
      step: mocks.logStep,
      success: mocks.logSuccess,
      warn: mocks.logWarn,
    },
  },
}));

vi.mock("../utils/configParser/androidParser", () => ({
  AndroidConfigParser: class {
    exists = mocks.androidExists;
    get = mocks.androidGet;
    set = mocks.androidSet;
  },
}));

vi.mock("../utils/configParser/iosParser", () => ({
  IosConfigParser: class {
    exists = mocks.iosExists;
    get = mocks.iosGet;
    set = mocks.iosSet;
  },
}));

vi.mock("../utils/expoDetection", () => ({
  warnIfExpoCNG: vi.fn(),
}));

import { secret } from "@hot-updater/cli-tools";

import { infisical } from "../infisical";
import { keysExportPublic, keysRemove } from "./keys";

const setStdinTTY = (isTTY: boolean | undefined) =>
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
const stdinIsTTY = process.stdin.isTTY;

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

/** A project that signs with `signing: secret("bundle-signing-key")`. */
const configureProject = async (
  cwd: string,
  { privateKey }: { readonly privateKey: string },
) => {
  mocks.getCwd.mockReturnValue(cwd);
  mocks.loadConfig.mockResolvedValue({
    signing: secret("bundle-signing-key"),
    secrets: {
      name: "team-store",
      get: async (names: readonly string[]) =>
        Object.fromEntries(names.map((name) => [name, privateKey])),
      set: async () => {},
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
    setStdinTTY(true);
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
    setStdinTTY(stdinIsTTY);
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
    await configureProject(cwd, next);
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
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("sha256:"),
    );
    expect(mocks.androidSet).not.toHaveBeenCalled();
  });

  it("keeps the normal confirmation for the same canonical public key", async () => {
    const keyPair = createKeyPair();
    const cwd = await createProject();
    await configureProject(cwd, keyPair);
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

  it("refuses to ask without a terminal, naming -y and -p, instead of waiting", async () => {
    setStdinTTY(undefined);
    const keyPair = createKeyPair();

    const cwd = await createProject();
    await configureProject(cwd, keyPair);
    mocks.androidGet.mockResolvedValue({ value: null, paths: [] });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process exit");
    });

    await expect(keysExportPublic()).rejects.toThrow("process exit");

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.androidSet).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      "Write public key?\nRe-run with -y to write it or -p to print it in a non-interactive shell.",
    );
  });

  it("treats --yes as an explicit trust-anchor replacement", async () => {
    const previous = createKeyPair();
    const next = createKeyPair();
    const cwd = await createProject();
    await configureProject(cwd, next);
    mocks.androidGet.mockResolvedValue({
      value: previous.publicKey,
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });

    await keysExportPublic({ yes: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.androidSet).toHaveBeenCalledWith(
      "com.hotupdater.PUBLIC_KEY",
      next.publicKey.trim(),
    );
  });

  it("exports the public key from local config", async () => {
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
      "com.hotupdater.PUBLIC_KEY",
      publicKey.trim(),
    );
  });

  it.each([
    [undefined, "hot-updater.config.ts signs no bundles."],
    [{ enabled: false }, "hot-updater.config.ts signs no bundles."],
    [
      { name: "awsKmsSigning", getPublicKey: vi.fn(), sign: vi.fn() },
      'signing takes secret("bundle-signing-key").\nStore your key: npx hot-updater secrets put bundle-signing-key <key.pem>',
    ],
  ])("exports nothing for signing %j", async (signing, reason) => {
    mocks.getCwd.mockReturnValue(await createProject());
    mocks.loadConfig.mockResolvedValue({
      signing,
      platform: {
        android: { androidManifestPaths: [] },
        ios: { infoPlistPaths: [] },
      },
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process exit");
    });

    await expect(keysExportPublic({ yes: true })).rejects.toThrow(
      "process exit",
    );

    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining(reason),
    );
    expect(mocks.androidSet).not.toHaveBeenCalled();
  });

  it("writes an Expo trust-anchor file without touching native files", async () => {
    const keyPair = createKeyPair();
    const { publicKey } = keyPair;
    const cwd = await createProject();
    await configureProject(cwd, keyPair);

    await keysExportPublic({ output: "config/signing-public.pem" });

    await expect(
      fs.readFile(path.join(cwd, "config/signing-public.pem"), "utf8"),
    ).resolves.toBe(publicKey);
    expect(mocks.androidGet).not.toHaveBeenCalled();
    expect(mocks.androidSet).not.toHaveBeenCalled();
  });
});

describe("keysExportPublic without the signing key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempProjects
        .splice(0)
        .map((project) => fs.rm(project, { force: true, recursive: true })),
    );
  });

  /** What export prints, and its exit code, for a `secrets` adapter's `get`. */
  const exportWith = async (get: () => Promise<Record<string, string>>) =>
    exportWithAdapter({ name: "infisical", get, set: async () => {} });

  /** What export prints, and its exit code, reading through `secrets`. */
  const exportWithAdapter = async (secrets: SecretsAdapter) => {
    const cwd = await createProject();
    mocks.getCwd.mockReturnValue(cwd);
    mocks.loadConfig.mockResolvedValue({
      signing: secret("qa-missing-key"),
      secrets,
      platform: { android: { androidManifestPaths: [] }, ios: {} },
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    await expect(keysExportPublic({ yes: true })).rejects.toThrow(
      "process.exit:1",
    );
    return renderClackLog(recordedClackCalls(p.log));
  };

  it("puts a missing key's cause and command on lines of their own", async () => {
    const lines = await exportWith(async () => ({}));

    expect(lines).toEqual([
      "│",
      "■  Public key not exported.",
      "│  qa-missing-key isn't in the infisical secrets adapter.",
      "│  Check the name and your access, or import your key:",
      "│  npx hot-updater secrets put qa-missing-key --kind bundle-signing-key \\",
      "│    <key.pem>",
    ]);
    expect(linesWiderThan(lines)).toEqual([]);
  });

  it("puts an adapter's refusal under a short head line", async () => {
    const lines = await exportWith(async () => {
      throw new Error(
        [
          "Infisical found nothing to list the secrets (404).",
          "Project with ID '00000000-0000-4000-8000-000000000000' not found during…",
          "Project 00000000-0000-4000-8000-000000000000.",
          "Environment prod, folder /.",
          "Check projectId, environment, and path.",
        ].join("\n"),
      );
    });

    expect(lines.slice(1, 4)).toEqual([
      "■  Public key not exported.",
      "│  Couldn't read qa-missing-key from the infisical secrets adapter.",
      "│  Infisical found nothing to list the secrets (404).",
    ]);
    expect(linesWiderThan(lines)).toEqual([]);
  });

  describe("with infisical()", () => {
    const PROJECT = "00000000-0000-4000-8000-000000000000";
    const DOCS_URL =
      "https://hot-updater.dev/docs/guides/secrets-adapters/infisical#sign-in-on-your-machine";
    const SIGN_IN_ENV = [
      "INFISICAL_TOKEN",
      "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
      "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
      "INFISICAL_MACHINE_IDENTITY_ID",
      "INFISICAL_DOMAIN",
      "INFISICAL_API_URL",
    ];
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const name of SIGN_IN_ENV) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    /** Infisical's answer to listing the folder: a 404 with `message`. */
    const listAnswers404 = (message: string) => {
      process.env["INFISICAL_TOKEN"] = "token";
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: "NotFound", message }, { status: 404 }),
      );
    };

    /** The lines a terminal shows wider than 76 columns, in display columns. */
    const over76 = (lines: readonly string[]) =>
      lines.filter((line) => displayColumns(line) > 76);

    it("keeps the sign-in hint within 76 columns but its URL, alone on a line", async () => {
      const lines = await exportWithAdapter(infisical({ projectId: PROJECT }));

      // A URL can't be broken: the one wider line is it, after the gutter.
      expect(over76(lines)).toEqual([`│  ${DOCS_URL}`]);
      expect(lines.at(-1)).toBe(`│  ${DOCS_URL}`);
    });

    it("cuts Infisical's message so its line, gutter and … included, is 76 columns", async () => {
      listAnswers404(
        `Project with ID '${PROJECT}' not found during bot authorization`,
      );

      const lines = await exportWithAdapter(infisical({ projectId: PROJECT }));

      expect(lines).toContain(
        `│  Project with ID '${PROJECT}' not found during…`,
      );
      expect(over76(lines)).toEqual([]);
    });

    it("measures display columns, not bytes or code units", async () => {
      // Each Hangul syllable takes two columns: a cut by length overflows.
      listAnswers404("프로젝트를 찾을 수 없습니다. ".repeat(8));

      const lines = await exportWithAdapter(
        infisical({
          projectId: PROJECT,
          environment: "production-codex-relay",
          path: "/hot-updater/codex-relay/android/release",
        }),
      );

      const quoted = lines.find((line) => line.includes("프로젝트"))!;
      expect(quoted.endsWith("…")).toBe(true);
      expect(displayColumns(quoted)).toBeGreaterThan(70);
      expect(over76(lines)).toEqual([]);
      expect(lines.join("\n")).toContain("production-codex-relay");
    });
  });
});

describe("keysRemove", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setStdinTTY(stdinIsTTY);
    process.exitCode = undefined;
  });

  it("refuses to ask without a terminal instead of waiting", async () => {
    vi.clearAllMocks();
    setStdinTTY(undefined);
    mocks.getCwd.mockReturnValue(os.tmpdir());
    mocks.loadConfig.mockResolvedValue({
      platform: {
        android: {
          androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
        },
        ios: { infoPlistPaths: [] },
      },
    });
    mocks.androidExists.mockResolvedValue(true);
    mocks.iosExists.mockResolvedValue(false);
    mocks.androidGet.mockResolvedValue({
      value: "key",
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });

    await keysRemove();

    expect(process.exitCode).toBe(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.androidSet).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      "Remove public keys from these files?\nRe-run with -y in a non-interactive shell.",
    );
  });
});

// The terminal these specs simulate takes prompts only outside CI, and CI
// runners set CI.
beforeEach(() => {
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
