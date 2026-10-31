import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadTeamSecrets: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadTeamSecrets: mocks.loadTeamSecrets,
    p: {
      ...actual.p,
      log: {
        ...actual.p.log,
        success: mocks.success,
        info: mocks.info,
        warn: mocks.warn,
      },
    },
  };
});

import { makeEnv } from "@hot-updater/cli-tools";

import { openInitTeamSecrets, storeInitTeamSecrets } from "./initSecrets";

const PROVIDER = {
  label: "Cloudflare",
  inputs: {},
  secrets: [
    "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
    "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
  ],
};

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-init-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

/** A team store shared by every clone, as a directory or a cloud store is. */
const teamStore = (initial: Readonly<Record<string, string>> = {}) => {
  const values = new Map(Object.entries(initial));
  const adapter = {
    name: "teamStore",
    get: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, values.get(name)])),
    ),
    set: vi.fn(async (name: string, value: string) => {
      values.set(name, value);
    }),
  } satisfies SecretsAdapter;
  return { adapter, values };
};

const envFile = () =>
  fs.readFile(path.join(directory, ".env.hotupdater"), "utf8");

describe("init with a team secrets store", () => {
  it("replays with what a teammate stored, stores what it saves, reads it back, and deletes nothing", async () => {
    // Given: a teammate stored the API token and the app's API key
    await makeEnv({ HOT_UPDATER_INIT_PROVIDER: "cloudflare" });
    const { adapter, values } = teamStore({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "stored-token",
      HOT_UPDATER_API_KEY: "stored-app-key",
    });
    mocks.loadTeamSecrets.mockResolvedValue(adapter);

    // When: init opens the store, then saves what it resolved, as runInit does
    const team = await openInitTeamSecrets({
      provider: PROVIDER,
      env: { HOT_UPDATER_INIT_PROVIDER: "cloudflare" },
      cwd: directory,
    });
    expect(team?.secretsEnv).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "stored-token",
      HOT_UPDATER_API_KEY: "stored-app-key",
    });
    await makeEnv({
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "stored-token",
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "new-access-key",
      HOT_UPDATER_API_KEY: "stored-app-key",
    });
    await storeInitTeamSecrets(team!, directory);

    // Then: the store holds every credential, read back once
    expect(Object.fromEntries(values)).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "stored-token",
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "new-access-key",
      HOT_UPDATER_API_KEY: "stored-app-key",
    });
    expect(adapter.get).toHaveBeenCalledTimes(2);
    // and .env.hotupdater keeps what init wrote, which the app's build reads
    expect(await envFile()).toContain("HOT_UPDATER_API_KEY=stored-app-key");
    expect(mocks.success).toHaveBeenCalledWith(
      [
        "Stored in the teamStore secrets adapter:",
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_API_KEY",
      ].join("\n"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      [
        ".env.hotupdater still sets them, overriding the adapter here.",
        "Delete those lines to read them from the adapter.",
      ].join("\n"),
    );
  });

  it("leaves .env.hotupdater as init wrote it when the store does not read back", async () => {
    const values = new Map<string, string>();
    const writeOnly = {
      name: "teamStore",
      get: vi.fn(async (names: readonly string[]) =>
        Object.fromEntries(names.map((name) => [name, values.get(name)])),
      ),
      set: vi.fn(async () => {}),
    } satisfies SecretsAdapter;
    mocks.loadTeamSecrets.mockResolvedValue(writeOnly);

    const team = await openInitTeamSecrets({
      provider: PROVIDER,
      env: {},
      cwd: directory,
    });
    await makeEnv({ HOT_UPDATER_CLOUDFLARE_API_TOKEN: "new-token" });
    await storeInitTeamSecrets(team!, directory);

    expect(await envFile()).toBe("HOT_UPDATER_CLOUDFLARE_API_TOKEN=new-token");
    expect(mocks.warn).toHaveBeenCalledWith(
      "The teamStore secrets adapter did not read back HOT_UPDATER_CLOUDFLARE_API_TOKEN (HOT_UPDATER_CLOUDFLARE_API_TOKEN in teamStore).\n.env.hotupdater keeps them.",
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("stops when a config that sets a team store doesn't load, so it never asks for or creates its credentials again", async () => {
    // Given: a config of an earlier release that no longer loads
    await fs.writeFile(
      path.join(directory, "hot-updater.config.ts"),
      [
        'import { defineConfig, secretEnv } from "hot-updater";',
        'import { infisical } from "hot-updater";',
        'const deploy = secretEnv(["HOT_UPDATER_CLOUDFLARE_API_TOKEN"]);',
        "export default defineConfig({",
        '  secrets: infisical({ projectId: "p" }),',
        "});",
      ].join("\n"),
    );
    mocks.loadTeamSecrets.mockRejectedValue(
      new TypeError("secretEnv is not a function"),
    );

    // Then
    await expect(
      openInitTeamSecrets({ provider: PROVIDER, env: {}, cwd: directory }),
    ).rejects.toThrow(
      "hot-updater.config.ts sets a secrets adapter, but doesn't load:\nsecretEnv is not a function\nFix it, then run init again.",
    );
  });

  it.each([
    ["no secrets", "export default defineConfig({});"],
    [
      "localSecrets()",
      "export default defineConfig({ secrets: localSecrets() });",
    ],
  ])(
    "goes on with .env.hotupdater when a config with %s doesn't load",
    async (_, text) => {
      await fs.writeFile(path.join(directory, "hot-updater.config.ts"), text);
      mocks.loadTeamSecrets.mockRejectedValue(new Error("broken"));

      await expect(
        openInitTeamSecrets({ provider: PROVIDER, env: {}, cwd: directory }),
      ).resolves.toBeUndefined();
      expect(mocks.warn).toHaveBeenCalledWith(
        [
          "Couldn't load hot-updater.config.ts for its secrets adapter.",
          "broken",
          "Credentials stay in .env.hotupdater.",
        ].join("\n"),
      );
    },
  );

  it("does nothing with localSecrets()", async () => {
    mocks.loadTeamSecrets.mockResolvedValue(undefined);

    await expect(
      openInitTeamSecrets({ provider: PROVIDER, env: {}, cwd: directory }),
    ).resolves.toBeUndefined();
  });
});
