import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkVaultMasterKey } from "./vaultMasterKey";

const projects: string[] = [];

const project = async (files: Record<string, string>) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-vault-"));
  projects.push(cwd);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(cwd, name), content);
  }
  return cwd;
};

afterEach(async () => {
  await Promise.all(
    projects.map((cwd) => fs.rm(cwd, { recursive: true, force: true })),
  );
  projects.length = 0;
});

describe("checkVaultMasterKey", () => {
  it("warns for each env file that keeps a master key beside database credentials", async () => {
    const cwd = await project({
      ".env.hotupdater":
        'HOT_UPDATER_VAULT_MASTER_KEYS="next:a,default:b"\nHOT_UPDATER_CLOUDFLARE_API_TOKEN=t\n',
      ".env": "HOT_UPDATER_VAULT_MASTER_KEY=a\nDATABASE_URL=postgres://x\n",
      ".env.local": "HOT_UPDATER_VAULT_MASTER_KEY=a\n",
    });

    const issues = await checkVaultMasterKey({ cwd, env: {} });

    expect(
      issues.map(({ source, masterKeys, credentials }) => ({
        source,
        masterKeys,
        credentials,
      })),
    ).toEqual([
      {
        source: ".env",
        masterKeys: ["HOT_UPDATER_VAULT_MASTER_KEY"],
        credentials: ["DATABASE_URL"],
      },
      {
        source: ".env.hotupdater",
        masterKeys: ["HOT_UPDATER_VAULT_MASTER_KEYS"],
        credentials: ["HOT_UPDATER_CLOUDFLARE_API_TOKEN"],
      },
    ]);
    expect(issues[0]).toMatchObject({
      type: "warning",
      code: "VAULT_MASTER_KEY_WITH_DATABASE_CREDENTIALS",
      fixability: "blocked",
      message: expect.stringContaining(".env holds the vault's master key"),
    });
  });

  it("says nothing for a master key kept apart, empty values, or example files", async () => {
    const cwd = await project({
      ".env.console": "HOT_UPDATER_VAULT_MASTER_KEY=a\n",
      ".env.hotupdater":
        "HOT_UPDATER_VAULT_MASTER_KEY=\nHOT_UPDATER_SUPABASE_DB_PASSWORD=p\n",
      ".env.example":
        "HOT_UPDATER_VAULT_MASTER_KEY=<key>\nDATABASE_URL=<url>\n",
    });

    await expect(checkVaultMasterKey({ cwd, env: {} })).resolves.toEqual([]);
  });

  it("checks the environment doctor runs in when no file explains it", async () => {
    const cwd = await project({});
    const env = {
      HOT_UPDATER_VAULT_MASTER_KEY: "a",
      HOT_UPDATER_S3_SECRET_ACCESS_KEY: "s",
    };

    await expect(checkVaultMasterKey({ cwd, env })).resolves.toEqual([
      expect.objectContaining({
        source: "process.env",
        message: expect.stringContaining(
          "The environment doctor runs in holds",
        ),
      }),
    ]);

    // A file doctor loaded explains the same names in its environment.
    const loaded = await project({
      ".env.hotupdater":
        "HOT_UPDATER_VAULT_MASTER_KEY=a\nHOT_UPDATER_S3_SECRET_ACCESS_KEY=s\n",
    });
    const issues = await checkVaultMasterKey({ cwd: loaded, env });
    expect(issues.map(({ source }) => source)).toEqual([".env.hotupdater"]);
  });
});
