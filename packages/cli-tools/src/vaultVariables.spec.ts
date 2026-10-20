import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh per test: the module keeps what each load set in process.env.
let maskSecretValues: typeof import("./secretMasking").maskSecretValues;
let loadVaultDeployCredentials: typeof import("./vaultVariables").loadVaultDeployCredentials;
let VaultDeployCredentialsError: typeof import("./vaultVariables").VaultDeployCredentialsError;

const CONSOLE_URL = "https://console.example.com";
const TOKEN = `hu_vault_${"D".repeat(43)}`;

const secret = (name: string, kind: string, variables: readonly string[]) => ({
  id: `sec-${name}`,
  name,
  kind,
  version: 1,
  metadata: { variables },
  createdAtMs: 0,
  updatedAtMs: 0,
});

const VALUES: Record<string, Record<string, string>> = {
  deploy: {
    SPEC_S3_ACCESS_KEY_ID: "AKIADEPLOYSPEC",
    SPEC_S3_SECRET_ACCESS_KEY: "deploy-spec-secret",
    SPEC_S3_BUCKET_NAME: "vault-bucket",
  },
};

/** A Console listing `listed` and resolving `VALUES`, and the requests it received. */
const mockConsole = (listed: ReturnType<typeof secret>[]) => {
  const requests: { method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET") {
      requests.push({ method: "GET", body: undefined });
      return Response.json({ secrets: listed });
    }
    const body = (await request.json()) as { names: string[] };
    requests.push({ method: "POST", body });
    return Response.json({
      secrets: body.names.map((name) => ({
        name,
        kind: "deploy-credentials",
        version: 1,
        value: VALUES[name],
      })),
      errors: [],
    });
  });
  return requests;
};

let cwd = "";

const writeEnvFile = (lines: readonly string[]) =>
  fs.writeFile(path.join(cwd, ".env.hotupdater"), lines.join("\n"));

beforeEach(async () => {
  vi.resetModules();
  ({ maskSecretValues } = await import("./secretMasking"));
  ({ loadVaultDeployCredentials, VaultDeployCredentialsError } =
    await import("./vaultVariables"));
  // Each directory loads once per process, so each test has its own.
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-vault-vars-"));
  // Unset: an empty one would hide .env.hotupdater's.
  vi.stubEnv("HOT_UPDATER_CONSOLE_URL", undefined);
  vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", undefined);
  for (const name of [...Object.keys(VALUES["deploy"]!), "SPEC_GENERIC"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("loadVaultDeployCredentials", () => {
  it("reaches nothing unless both connection variables are set", async () => {
    const requests = mockConsole([]);
    await writeEnvFile([`HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`]);

    await loadVaultDeployCredentials(cwd);

    expect(requests).toEqual([]);
  });

  it("sets the deploy-credentials variables not set in the environment or .env.hotupdater, once, masked", async () => {
    const requests = mockConsole([
      secret("deploy", "deploy-credentials", Object.keys(VALUES["deploy"]!)),
      secret("scripts", "generic", ["SPEC_GENERIC"]),
    ]);
    await writeEnvFile([
      `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`,
      `HOT_UPDATER_VAULT_TOKEN=${TOKEN}`,
      "SPEC_S3_BUCKET_NAME=local-bucket",
    ]);
    vi.stubEnv("SPEC_S3_ACCESS_KEY_ID", "AKIAFROMENV");

    await loadVaultDeployCredentials(cwd);
    await loadVaultDeployCredentials(cwd);

    expect(process.env["SPEC_S3_SECRET_ACCESS_KEY"]).toBe("deploy-spec-secret");
    // Set locally: the environment and the file win.
    expect(process.env["SPEC_S3_ACCESS_KEY_ID"]).toBe("AKIAFROMENV");
    expect(process.env["SPEC_S3_BUCKET_NAME"]).toBe("");
    // A generic secret is for secrets env, not the config.
    expect(process.env["SPEC_GENERIC"]).toBe("");
    expect(requests).toEqual([
      { method: "GET", body: undefined },
      { method: "POST", body: { names: ["deploy"] } },
    ]);
    expect(maskSecretValues("key deploy-spec-secret")).not.toContain(
      "deploy-spec-secret",
    );
  });

  it("sets each directory's own credentials, restoring what another directory's load set", async () => {
    const other = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-vault-vars-"),
    );
    const otherToken = `hu_vault_${"O".repeat(43)}`;
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const mine = request.headers.get("authorization") === `Bearer ${TOKEN}`;
      requests.push(`${mine ? "cwd" : "other"} ${request.method}`);
      const [listed, value] = mine
        ? [
            ["SPEC_S3_ACCESS_KEY_ID", "SPEC_S3_SECRET_ACCESS_KEY"],
            VALUES["deploy"],
          ]
        : [["SPEC_S3_ACCESS_KEY_ID"], { SPEC_S3_ACCESS_KEY_ID: "AKIAOTHER" }];
      return request.method === "GET"
        ? Response.json({
            secrets: [secret("deploy", "deploy-credentials", listed!)],
          })
        : Response.json({
            secrets: [
              { name: "deploy", kind: "deploy-credentials", version: 1, value },
            ],
            errors: [],
          });
    });
    vi.stubEnv("SPEC_S3_SECRET_ACCESS_KEY", undefined);
    try {
      await writeEnvFile([
        `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`,
        `HOT_UPDATER_VAULT_TOKEN=${TOKEN}`,
      ]);
      await fs.writeFile(
        path.join(other, ".env.hotupdater"),
        [
          `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`,
          `HOT_UPDATER_VAULT_TOKEN=${otherToken}`,
        ].join("\n"),
      );

      await loadVaultDeployCredentials(cwd);
      expect(process.env["SPEC_S3_ACCESS_KEY_ID"]).toBe("AKIADEPLOYSPEC");

      await loadVaultDeployCredentials(other);
      // Not the first directory's: its own, and nothing it does not hold.
      expect(process.env["SPEC_S3_ACCESS_KEY_ID"]).toBe("AKIAOTHER");
      expect(process.env["SPEC_S3_SECRET_ACCESS_KEY"]).toBeUndefined();

      await loadVaultDeployCredentials(cwd);
      expect(process.env["SPEC_S3_ACCESS_KEY_ID"]).toBe("AKIADEPLOYSPEC");
      expect(process.env["SPEC_S3_SECRET_ACCESS_KEY"]).toBe(
        "deploy-spec-secret",
      );
      expect(requests).toEqual([
        "cwd GET",
        "cwd POST",
        "other GET",
        "other POST",
      ]);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("only lists when the token reaches no deploy-credentials secret", async () => {
    const requests = mockConsole([secret("scripts", "generic", ["X"])]);
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", TOKEN);

    await loadVaultDeployCredentials(cwd);

    expect(requests).toEqual([{ method: "GET", body: undefined }]);
  });

  it("fails naming the Console and how to load the config without it", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", TOKEN);

    const loading = loadVaultDeployCredentials(cwd);
    await expect(loading).rejects.toBeInstanceOf(VaultDeployCredentialsError);
    await expect(loading).rejects.toThrow(
      `Could not reach the Console at ${CONSOLE_URL} (ECONNREFUSED). hot-updater.config.ts reads the vault's deploy-credentials while HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN are set; set the variables it needs in the environment or .env.hotupdater to load it without the Console.`,
    );
  });
});
