import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { maskSecretValues } from "./secretMasking";
import {
  readMissingFromTeamSecrets,
  StoredSecretsConflictError,
  storeEnvFileSecrets,
} from "./teamSecrets";

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
  it("stores the names .env.hotupdater sets, reads what it holds and then back in one get each, and leaves the file as it is", async () => {
    const file = [
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=account-id",
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token-value",
      'HOT_UPDATER_API_KEY="app-api-key"',
      "",
    ].join("\n");
    await writeEnvFile(file);
    const { adapter, values } = teamStore();

    const result = await storeEnvFileSecrets(
      adapter,
      [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_API_KEY",
      ],
      directory,
    );

    expect(result).toEqual({
      stored: ["HOT_UPDATER_CLOUDFLARE_API_TOKEN", "HOT_UPDATER_API_KEY"],
      unchanged: [],
    });
    expect(Object.fromEntries(values)).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token-value",
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    expect(adapter.get).toHaveBeenCalledTimes(2);
    expect(
      await fs.readFile(path.join(directory, ".env.hotupdater"), "utf8"),
    ).toBe(file);
    expect(maskSecretValues("token api-token-value")).toBe("token ********");
  });

  it("refuses another value the adapter holds and writes nothing, naming every conflicting name", async () => {
    await writeEnvFile(
      [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token-value",
        "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=new-account-id",
        "HOT_UPDATER_API_KEY=new-app-api-key",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID=access-key-id",
        "",
      ].join("\n"),
    );
    const { adapter, values } = teamStore({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token-value",
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "old-account-id",
      HOT_UPDATER_API_KEY: "old-app-api-key",
    });

    const error = await storeEnvFileSecrets(
      adapter,
      [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
        "HOT_UPDATER_API_KEY",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
      ],
      directory,
    ).catch((caught: unknown) => caught);

    expect(adapter.set).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(StoredSecretsConflictError);
    expect((error as StoredSecretsConflictError).names).toEqual([
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
      "HOT_UPDATER_API_KEY",
    ]);
    // Never a value: only the names.
    expect((error as Error).message).not.toMatch(/app-api-key|account-id\b/);
    expect(Object.fromEntries(values)).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token-value",
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "old-account-id",
      HOT_UPDATER_API_KEY: "old-app-api-key",
    });
  });

  it("with replace, writes another value the adapter holds, but no new version of the same one, and reads back only what it wrote", async () => {
    await writeEnvFile(
      [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token-value",
        "HOT_UPDATER_API_KEY=new-app-api-key",
        "",
      ].join("\n"),
    );
    const { adapter, values } = teamStore({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token-value",
      HOT_UPDATER_API_KEY: "old-app-api-key",
    });

    const result = await storeEnvFileSecrets(
      adapter,
      ["HOT_UPDATER_CLOUDFLARE_API_TOKEN", "HOT_UPDATER_API_KEY"],
      directory,
      { replace: true },
    );

    expect(result).toEqual({
      stored: ["HOT_UPDATER_API_KEY"],
      unchanged: ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"],
    });
    expect(adapter.set.mock.calls.map(([name]) => name)).toEqual([
      "HOT_UPDATER_API_KEY",
    ]);
    expect(values.get("HOT_UPDATER_API_KEY")).toBe("new-app-api-key");
    expect(adapter.get.mock.calls.map(([names]) => names)).toEqual([
      ["HOT_UPDATER_CLOUDFLARE_API_TOKEN", "HOT_UPDATER_API_KEY"],
      ["HOT_UPDATER_API_KEY"],
    ]);
  });

  it("writes and reads back nothing when the adapter holds every value, and says they were already stored", async () => {
    await writeEnvFile("HOT_UPDATER_API_KEY=app-api-key\n");
    const { adapter } = teamStore({ HOT_UPDATER_API_KEY: "app-api-key" });

    const result = await storeEnvFileSecrets(
      adapter,
      ["HOT_UPDATER_API_KEY"],
      directory,
    );

    expect(result).toEqual({ stored: [], unchanged: ["HOT_UPDATER_API_KEY"] });
    expect(adapter.set).not.toHaveBeenCalled();
    expect(adapter.get).toHaveBeenCalledOnce();
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
    ).resolves.toEqual({ stored: [], unchanged: [] });
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
