import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { getSecretEnvNames, localSecrets } from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkSecretEnv,
  secretEnvAdvice,
  secretEnvInitCommand,
} from "./secretEnv";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getSecretEnvNames: vi.fn(),
}));

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(cwd, { force: true, recursive: true });
});

const configOf = (
  secrets: SecretsAdapter | undefined,
  names: readonly string[],
) => {
  vi.mocked(getSecretEnvNames).mockReturnValue(names);
  return { secrets: secrets ?? localSecrets() } as never;
};

const teamStore = (values: Readonly<Record<string, string>>) => ({
  name: "teamStore",
  get: vi.fn(async (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  ),
  set: vi.fn(async () => {}),
});

describe("doctor's secretEnv rows", () => {
  it("says where each name comes from, with one get of them all", async () => {
    await fs.writeFile(
      path.join(cwd, ".env.hotupdater"),
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN=local\n",
    );
    const store = teamStore({
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "stored",
    });

    const status = await checkSecretEnv(
      configOf(store, [
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
        "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
      ]),
      { cwd },
    );

    expect(status).toEqual({
      adapter: "teamStore",
      names: [
        {
          name: "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
          source: "environment",
          inAdapter: false,
        },
        {
          name: "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
          source: "adapter",
          inAdapter: true,
        },
        {
          name: "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
          source: "missing",
          inAdapter: false,
        },
      ],
      processEnvReads: [],
    });
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("reads only the environment with localSecrets(), as secretEnv does", async () => {
    vi.stubEnv("HOT_UPDATER_API_TOKEN_SPEC", "from-shell");

    const status = await checkSecretEnv(
      configOf(undefined, [
        "HOT_UPDATER_API_TOKEN_SPEC",
        "HOT_UPDATER_MISSING",
      ]),
      { cwd },
    );

    expect(status?.adapter).toBeUndefined();
    expect(status?.names).toEqual([
      { name: "HOT_UPDATER_API_TOKEN_SPEC", source: "environment" },
      { name: "HOT_UPDATER_MISSING", source: "missing" },
    ]);
  });

  it("reports an adapter it can't read, without failing", async () => {
    const store = {
      name: "teamStore",
      get: vi.fn(async () => {
        throw new Error("access denied");
      }),
      set: vi.fn(async () => {}),
    };

    const status = await checkSecretEnv(
      configOf(store, ["HOT_UPDATER_MISSING"]),
      { cwd },
    );

    expect(status).toMatchObject({
      error: "access denied",
      names: [{ name: "HOT_UPDATER_MISSING" }],
    });
  });

  it("names a managed credential the config still reads with process.env, only with a team store", async () => {
    await fs.writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      "cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,\n",
    );
    const managedSecrets = vi.fn(async () => [
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
      "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
    ]);

    await expect(
      checkSecretEnv(configOf(teamStore({}), []), { cwd, managedSecrets }),
    ).resolves.toEqual({
      adapter: "teamStore",
      names: [],
      processEnvReads: ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"],
    });
    managedSecrets.mockClear();
    await expect(
      checkSecretEnv(configOf(undefined, []), { cwd, managedSecrets }),
    ).resolves.toBeUndefined();
    // Without a team store, the provider's init is never loaded.
    expect(managedSecrets).not.toHaveBeenCalled();
  });
});

describe("doctor's advice for credentials read with process.env", () => {
  const managed = {
    provider: "cloudflare",
    command:
      "npx hot-updater init --provider cloudflare --from-env-file .env.hotupdater",
    confirmed: true,
    foreignPlugins: [],
  } as const;
  const scaffold = { provider: "cloudflare" } as const;

  it("names init's command only for a deployment init manages", () => {
    expect(secretEnvInitCommand({ managed, scaffolds: [] })).toBe(
      managed.command,
    );
    // A scaffold of another provider keeps another deployment.
    expect(
      secretEnvInitCommand({ managed, scaffolds: [{ provider: "aws" }] }),
    ).toBe(managed.command);
  });

  it.each([
    ["an agent scaffold keeps the deployment", managed, [scaffold]],
    ["no deployment is init's", null, []],
    [
      "the database may not be the one init saved",
      { ...managed, confirmed: false },
      [],
    ],
    [
      "the config lists a plugin the managed server does not run",
      { ...managed, foreignPlugins: ["audit"] },
      [],
    ],
  ] as const)("never names init when %s", (_, deployment, scaffolds) => {
    expect(
      secretEnvInitCommand({ managed: deployment, scaffolds }),
    ).toBeUndefined();
  });

  it("is one line and a link without init, else init's command", () => {
    expect(
      secretEnvAdvice("them", undefined).map(stripVTControlCharacters),
    ).toEqual([
      "Read them with secretEnv in hot-updater.config.ts:",
      "https://hot-updater.dev/docs/concepts/secrets#deploy-credentials-with-secretenv",
    ]);
    expect(
      secretEnvAdvice("it", managed.command)
        .join("\n")
        .split("\n")
        .map(stripVTControlCharacters),
    ).toEqual([
      "Run init again to read it with secretEnv:",
      "npx hot-updater init --provider cloudflare --from-env-file \\",
      "  .env.hotupdater",
    ]);
  });
});
