import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getDeploySecretNames,
  loadConfig,
  localSecrets,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSecretsImport } from "./secrets";

const { log, printBanner } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

// Only the config and the log are mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getDeploySecretNames: vi.fn(),
  loadConfig: vi.fn(),
  p: { isCancel: vi.fn(() => false), log },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));

/** The team store the config sets, holding what import stores. */
const teamStore = () => {
  const held = new Map<string, string>();
  const store = {
    name: "teamStore",
    get: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, held.get(name)])),
    ),
    set: vi.fn(async (name: string, value: string) => {
      held.set(name, value);
    }),
  } satisfies SecretsAdapter;
  return { store, held };
};

/** The config loadConfig hands over, whose adapters' `secret()`s read `names`. */
const configure = (
  secrets: SecretsAdapter | undefined,
  names: readonly string[],
) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: secrets ?? localSecrets(),
  } as never);
  vi.mocked(getDeploySecretNames).mockReturnValue(names);
};

const ENV_FILE = [
  "HOT_UPDATER_INIT_PROVIDER=cloudflare",
  "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=account-id",
  "HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token",
  "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID=access-key",
  "HOT_UPDATER_API_KEY=app-api-key",
  "",
].join("\n");

let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-import-"));
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  await fs.writeFile(path.join(directory, ".env.hotupdater"), ENV_FILE);
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater secrets import", () => {
  it("stores what the adapters' secret()s read and the app's API key from .env.hotupdater, reads them back, and deletes nothing", async () => {
    const { store, held } = teamStore();
    configure(store, [
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
      "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
      "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    ]);

    await handleSecretsImport();

    expect(process.exitCode).toBeUndefined();
    expect(Object.fromEntries(held)).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token",
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key",
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(log.success).toHaveBeenCalledWith(
      [
        "Stored in the teamStore secrets adapter",
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_API_KEY",
      ].join("\n"),
    );
    expect(log.info).toHaveBeenCalledWith(
      [
        ".env.hotupdater still sets them where it is loaded, over the adapter.",
        "Delete those lines to read them from the adapter.",
      ].join("\n"),
    );
    // One idea per line, inside clack's gutter on 76 columns.
    for (const [message] of [
      ...log.success.mock.calls,
      ...log.info.mock.calls,
    ]) {
      for (const line of String(message).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(73);
      }
    }
    expect(
      await fs.readFile(path.join(directory, ".env.hotupdater"), "utf8"),
    ).toBe(ENV_FILE);
  });

  it("refuses without a team store", async () => {
    configure(undefined, ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"]);

    await handleSecretsImport();

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "hot-updater.config.ts sets no secrets adapter.\nSet secrets to a team store first.",
    );
  });

  it("stores the app's API key for a config with no adapter secret(), such as Firebase's", async () => {
    const { store, held } = teamStore();
    configure(store, []);

    await handleSecretsImport();

    expect(process.exitCode).toBeUndefined();
    expect(Object.fromEntries(held)).toEqual({
      HOT_UPDATER_API_KEY: "app-api-key",
    });
  });

  it("refuses when .env.hotupdater sets none of the names", async () => {
    const { store } = teamStore();
    configure(store, []);
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      "HOT_UPDATER_INIT_PROVIDER=firebase\n",
    );

    await handleSecretsImport();

    expect(process.exitCode).toBe(1);
    expect(store.set).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      ".env.hotupdater sets none of these:\nHOT_UPDATER_API_KEY",
    );
  });

  it("reads the env file it is given instead, and never the environment", async () => {
    const { store, held } = teamStore();
    configure(store, [
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
      "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    ]);
    await fs.writeFile(
      path.join(directory, ".env.hotupdater.rc22"),
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN=rc22-token\n",
    );
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY", "shell-secret");

    try {
      await handleSecretsImport(".env.hotupdater.rc22");
    } finally {
      vi.unstubAllEnvs();
    }

    expect(process.exitCode).toBeUndefined();
    expect(Object.fromEntries(held)).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "rc22-token",
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^\.env\.hotupdater\.rc22 still sets them/u),
    );
  });

  it("refuses an env file it is given that can't be read", async () => {
    const { store } = teamStore();
    configure(store, ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"]);

    await handleSecretsImport(".env.missing");

    expect(process.exitCode).toBe(1);
    expect(store.set).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Can't read \.env\.missing\.\nENOENT/u),
    );
  });
});
