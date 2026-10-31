import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { maskSecretValues } from "./secretMasking";
import { readMissingFromTeamSecrets, storeEnvFileSecrets } from "./teamSecrets";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-team-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { force: true, recursive: true });
});

/** A team store in memory, as a shared directory or a cloud store keeps values. */
const teamStore = (
  initial: Readonly<Record<string, string>> = {},
  { readBack = true }: { readonly readBack?: boolean } = {},
) => {
  const values = new Map(Object.entries(initial));
  const adapter = {
    name: "teamStore",
    get: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, values.get(name)])),
    ),
    set: vi.fn(async (name: string, value: string) => {
      if (readBack) values.set(name, value);
    }),
    describe: (name: string) => `team://${name}`,
  } satisfies SecretsAdapter;
  return { adapter, values };
};

const writeEnvFile = (text: string) =>
  fs.writeFile(path.join(directory, ".env.hotupdater"), text);

describe("storeEnvFileSecrets", () => {
  it("stores the names .env.hotupdater sets, reads them back in one get, and leaves the file as it is", async () => {
    const file = [
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=account-id",
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token-value",
      'HOT_UPDATER_API_KEY="app-api-key"',
      "",
    ].join("\n");
    await writeEnvFile(file);
    const { adapter, values } = teamStore();

    const stored = await storeEnvFileSecrets(
      adapter,
      [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_API_KEY",
      ],
      directory,
    );

    expect(stored).toEqual([
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
      "HOT_UPDATER_API_KEY",
    ]);
    expect(Object.fromEntries(values)).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token-value",
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    expect(adapter.get).toHaveBeenCalledTimes(1);
    expect(
      await fs.readFile(path.join(directory, ".env.hotupdater"), "utf8"),
    ).toBe(file);
    expect(maskSecretValues("token api-token-value")).toBe("token ********");
  });

  it("reads the file, not a value the environment sets over it", async () => {
    await writeEnvFile("HOT_UPDATER_CLOUDFLARE_API_TOKEN=from-file\n");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_API_TOKEN", "from-shell");
    const { adapter, values } = teamStore();

    await storeEnvFileSecrets(
      adapter,
      ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"],
      directory,
    );

    expect(values.get("HOT_UPDATER_CLOUDFLARE_API_TOKEN")).toBe("from-file");
  });

  it("names what the adapter did not read back", async () => {
    await writeEnvFile("HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token-value\n");
    const { adapter } = teamStore({}, { readBack: false });

    await expect(
      storeEnvFileSecrets(
        adapter,
        ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"],
        directory,
      ),
    ).rejects.toThrow(
      "The teamStore secrets adapter did not read back HOT_UPDATER_CLOUDFLARE_API_TOKEN (team://HOT_UPDATER_CLOUDFLARE_API_TOKEN).",
    );
  });

  it("stores nothing when the file sets none of the names", async () => {
    const { adapter } = teamStore();

    await expect(
      storeEnvFileSecrets(adapter, ["HOT_UPDATER_API_KEY"], directory),
    ).resolves.toEqual([]);
    expect(adapter.set).not.toHaveBeenCalled();
  });
});

describe("readMissingFromTeamSecrets", () => {
  it("reads only the names the environment and init's env files lack, in one get", async () => {
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID", "from-shell");
    const { adapter } = teamStore({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "from-store",
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "store-loses",
      HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: "store-loses-too",
    });

    const values = await readMissingFromTeamSecrets(
      adapter,
      [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
        "HOT_UPDATER_API_KEY",
      ],
      {
        env: { HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: "from-file" },
        cwd: directory,
      },
    );

    expect({ ...values }).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "from-store",
    });
    expect(adapter.get).toHaveBeenCalledTimes(1);
    expect(adapter.get).toHaveBeenCalledWith(
      ["HOT_UPDATER_CLOUDFLARE_API_TOKEN", "HOT_UPDATER_API_KEY"],
      { cwd: directory },
    );
  });

  it("reads nothing when every name is set", async () => {
    const { adapter } = teamStore();

    await readMissingFromTeamSecrets(adapter, ["HOT_UPDATER_API_KEY"], {
      env: { HOT_UPDATER_API_KEY: "app-api-key" },
      cwd: directory,
    });

    expect(adapter.get).not.toHaveBeenCalled();
  });
});
