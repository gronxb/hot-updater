import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getSecretEnvNames,
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
  getSecretEnvNames: vi.fn(),
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

/** The config loadConfig hands over, whose secretEnv reads `names`. */
const configure = (
  secrets: SecretsAdapter | undefined,
  names: readonly string[],
) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: secrets ?? localSecrets(),
  } as never);
  vi.mocked(getSecretEnvNames).mockReturnValue(names);
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
  it("stores what secretEnv reads and the app's API key from .env.hotupdater, reads them back, and deletes nothing", async () => {
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
      "Stored HOT_UPDATER_CLOUDFLARE_API_TOKEN, HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID, and HOT_UPDATER_API_KEY in the teamStore secrets adapter.",
    );
    expect(log.info).toHaveBeenCalledWith(
      ".env.hotupdater still sets them: delete those lines, or keep them to override the adapter here.",
    );
    expect(
      await fs.readFile(path.join(directory, ".env.hotupdater"), "utf8"),
    ).toBe(ENV_FILE);
  });

  it("refuses without a team store", async () => {
    configure(undefined, ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"]);

    await handleSecretsImport();

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "hot-updater.config.ts sets no secrets adapter, so .env.hotupdater is already where secrets are read.\nSet secrets to a team store first.",
    );
  });

  it("refuses a config that reads its credentials with process.env, which no store supplies", async () => {
    const { store } = teamStore();
    configure(store, []);

    await handleSecretsImport();

    expect(process.exitCode).toBe(1);
    expect(store.set).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "hot-updater.config.ts reads no credential with secretEnv, so nothing would read them from teamStore.\nRead them with secretEnv first: https://hot-updater.dev/docs/concepts/secrets#deploy-credentials-with-secretenv",
    );
  });
});
