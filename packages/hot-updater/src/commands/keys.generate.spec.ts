import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
  logs: [] as string[],
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  const record = (message: unknown) => {
    mocks.logs.push(String(message));
  };
  return {
    ...actual,
    getCwd: mocks.getCwd,
    loadConfig: mocks.loadConfig,
    p: {
      ...actual.p,
      log: {
        error: record,
        info: record,
        message: record,
        success: record,
        warn: record,
      },
      spinner: () => ({ error: record, start: record, stop: record }),
    },
  };
});

vi.mock("../utils/git", () => ({
  appendToProjectRootGitignore: vi.fn(() => true),
}));

import { envSecrets } from "@hot-updater/cli-tools";

import { keysGenerate } from "./keys";

const projects: string[] = [];

const createProject = async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keys-generate-"));
  projects.push(cwd);
  mocks.getCwd.mockReturnValue(cwd);
  return cwd;
};

/** A secrets adapter that stores values in memory. */
const writableSecrets = (values: Record<string, string> = {}) => {
  const set = vi.fn<NonNullable<SecretsAdapter["set"]>>(async (name, value) => {
    values[name] = value;
  });
  const secrets: SecretsAdapter = {
    name: "fake",
    get: async (names) =>
      Object.fromEntries(names.map((name) => [name, values[name]])),
    set,
    describe: (name) => `fake://store/${name}`,
  };
  return { secrets, set, values };
};

const exit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);

const output = () => mocks.logs.join("\n");

const listFiles = async (dir: string) =>
  fs.readdir(dir).catch(() => [] as string[]);

beforeEach(() => {
  mocks.logs.length = 0;
  mocks.loadConfig.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env["HOT_UPDATER_BUNDLE_SIGNING_KEY"];
  await Promise.all(
    projects
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("keys generate --secret", () => {
  it("stores the private key through a writable adapter and writes only the public key", async () => {
    const cwd = await createProject();
    const { secrets, set, values } = writableSecrets();
    mocks.loadConfig.mockResolvedValue({ secrets });

    await keysGenerate({ keySize: 2048, secret: true });

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]?.[0]).toBe("bundle-signing-key");
    const privateKey = values["bundle-signing-key"]!;
    expect(privateKey).toContain("BEGIN PRIVATE KEY");
    expect(await listFiles(path.join(cwd, "keys"))).toEqual(["public-key.pem"]);
    const publicKey = await fs.readFile(
      path.join(cwd, "keys/public-key.pem"),
      "utf8",
    );
    expect(
      crypto
        .createPublicKey(privateKey)
        .export({ format: "pem", type: "spki" }),
    ).toBe(publicKey);
    expect(output()).toContain('privateKey: "secret:bundle-signing-key"');
    expect(output()).toContain("fake://store/bundle-signing-key");
    expect(output()).not.toContain(privateKey.split("\n")[1]);
  });

  it("stores under the name --secret gives", async () => {
    await createProject();
    const { secrets, values } = writableSecrets();
    mocks.loadConfig.mockResolvedValue({ secrets });

    await keysGenerate({ keySize: 2048, secret: "release-signing-key" });

    expect(Object.keys(values)).toEqual(["release-signing-key"]);
    expect(output()).toContain('privateKey: "secret:release-signing-key"');
  });

  it("writes an owner-only private key file and names env()'s variable when the adapter is read-only", async () => {
    const cwd = await createProject();
    mocks.loadConfig.mockResolvedValue({ secrets: envSecrets() });

    await keysGenerate({ keySize: 2048, secret: true });

    const privateKeyPath = path.join(cwd, "keys/private-key.pem");
    const privateKey = await fs.readFile(privateKeyPath, "utf8");
    expect((await fs.stat(privateKeyPath)).mode & 0o777).toBe(0o600);
    expect((await listFiles(path.join(cwd, "keys"))).sort()).toEqual([
      "private-key.pem",
      "public-key.pem",
    ]);
    expect(output()).toContain(
      `The env secrets adapter is read-only, so the private key is in ${privateKeyPath}, readable only by you. Store its contents as HOT_UPDATER_BUNDLE_SIGNING_KEY in the environment or .env.hotupdater, such as a CI secret, then delete the file.`,
    );
    expect(output()).toContain('privateKey: "secret:bundle-signing-key"');
    expect(output()).not.toContain(privateKey.split("\n")[1]);
  });

  it("never replaces a key the secret already holds", async () => {
    const cwd = await createProject();
    const { secrets, set } = writableSecrets({
      "bundle-signing-key": "existing",
    });
    mocks.loadConfig.mockResolvedValue({ secrets });
    exit();

    await expect(keysGenerate({ keySize: 2048, secret: true })).rejects.toThrow(
      "process.exit",
    );

    expect(set).not.toHaveBeenCalled();
    expect(await listFiles(path.join(cwd, "keys"))).toEqual([]);
    expect(output()).toContain(
      "bundle-signing-key already holds a value in the fake secrets adapter (fake://store/bundle-signing-key), and keys generate never replaces it",
    );
  });

  it("never replaces a key env() already holds", async () => {
    const cwd = await createProject();
    process.env["HOT_UPDATER_BUNDLE_SIGNING_KEY"] = "existing";
    mocks.loadConfig.mockResolvedValue({ secrets: envSecrets() });
    exit();

    await expect(keysGenerate({ keySize: 2048, secret: true })).rejects.toThrow(
      "process.exit",
    );

    expect(await listFiles(path.join(cwd, "keys"))).toEqual([]);
    expect(output()).toContain("bundle-signing-key already holds a value");
  });

  it("removes the public key when storing the private key fails", async () => {
    const cwd = await createProject();
    const { secrets, set } = writableSecrets();
    set.mockRejectedValueOnce(new Error("permission denied"));
    mocks.loadConfig.mockResolvedValue({ secrets });
    exit();

    await expect(keysGenerate({ keySize: 2048, secret: true })).rejects.toThrow(
      "process.exit",
    );

    expect(await listFiles(path.join(cwd, "keys"))).toEqual([]);
    expect(output()).toContain("permission denied");
  });

  it("stores nothing when a public key already exists", async () => {
    const cwd = await createProject();
    await fs.mkdir(path.join(cwd, "keys"));
    await fs.writeFile(path.join(cwd, "keys/public-key.pem"), "kept");
    const { secrets, set } = writableSecrets();
    mocks.loadConfig.mockResolvedValue({ secrets });
    exit();

    await expect(keysGenerate({ keySize: 2048, secret: true })).rejects.toThrow(
      "process.exit",
    );

    expect(set).not.toHaveBeenCalled();
    expect(
      await fs.readFile(path.join(cwd, "keys/public-key.pem"), "utf8"),
    ).toBe("kept");
  });

  it("refuses a name that is no secret name before reading the config", async () => {
    await createProject();
    exit();

    await expect(
      keysGenerate({ keySize: 2048, secret: "../key" }),
    ).rejects.toThrow("process.exit");

    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(output()).toContain('"../key" is no secret name');
  });
});
