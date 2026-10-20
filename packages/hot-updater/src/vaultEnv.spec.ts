import { maskSecretValues } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultEnv } from "./vaultEnv";

const CONSOLE_URL = "https://console.example.com";

const secret = (name: string, variables: readonly string[]) => ({
  id: `sec-${name}`,
  name,
  kind: "deploy-credentials",
  version: 1,
  metadata: { variables },
  createdAtMs: 0,
  updatedAtMs: 0,
});

const VALUES: Record<string, Record<string, string>> = {
  aws: {
    S3_ACCESS_KEY_ID: "AKIAVAULTSPEC",
    S3_SECRET_ACCESS_KEY: "vault-spec-secret",
  },
  r2: { R2_TOKEN: "r2-token-value", S3_ACCESS_KEY_ID: "other" },
};

/** A Console listing `listed` and resolving `VALUES`, and the requests it received. */
const mockConsole = (listed: ReturnType<typeof secret>[]) => {
  const requests: { method: string; body: unknown }[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
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
  return { fetch, requests };
};

beforeEach(() => {
  vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
  vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", `hu_vault_${"V".repeat(43)}`);
  vi.stubEnv("S3_ACCESS_KEY_ID", "");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("vaultEnv", () => {
  it("reaches nothing until it is called, then resolves the secrets that list the names, masked", async () => {
    const { fetch, requests } = mockConsole([
      secret("aws", ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
    ]);

    const deploy = vaultEnv(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(fetch).not.toHaveBeenCalled();

    await expect(deploy()).resolves.toEqual(VALUES["aws"]);
    expect(requests).toEqual([
      { method: "GET", body: undefined },
      { method: "POST", body: { names: ["aws"] } },
    ]);
    expect(maskSecretValues("key vault-spec-secret")).not.toContain(
      "vault-spec-secret",
    );

    // No cache: each call reaches the Console again.
    await deploy();
    expect(requests).toHaveLength(4);
  });

  it("takes a name set in the environment over the vault, and reaches no Console when every name is set", async () => {
    const { fetch } = mockConsole([
      secret("aws", ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
    ]);
    vi.stubEnv("S3_ACCESS_KEY_ID", "from-env");

    await expect(
      vaultEnv(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])(),
    ).resolves.toEqual({
      S3_ACCESS_KEY_ID: "from-env",
      S3_SECRET_ACCESS_KEY: "vault-spec-secret",
    });

    fetch.mockClear();
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "also-env");
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", "");
    await expect(
      vaultEnv(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])(),
    ).resolves.toEqual({
      S3_ACCESS_KEY_ID: "from-env",
      S3_SECRET_ACCESS_KEY: "also-env",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the connection variables and the names to set instead when the vault is not connected", async () => {
    const { fetch } = mockConsole([]);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", "");

    await expect(vaultEnv(["S3_SECRET_ACCESS_KEY"])()).rejects.toThrow(
      "vaultEnv resolves S3_SECRET_ACCESS_KEY from the Console's vault, and HOT_UPDATER_VAULT_TOKEN is not set. Set HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN to reach the vault. Or set S3_SECRET_ACCESS_KEY in the environment.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a name no secret sets, and one two secrets set", async () => {
    mockConsole([
      secret("aws", ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
      secret("r2", ["R2_TOKEN", "S3_ACCESS_KEY_ID"]),
    ]);

    await expect(vaultEnv(["MISSING"])()).rejects.toThrow(
      `No deploy-credentials or generic secret the vault token reaches at ${CONSOLE_URL} sets MISSING.`,
    );
    await expect(vaultEnv(["S3_ACCESS_KEY_ID"])()).rejects.toThrow(
      'S3_ACCESS_KEY_ID is set by the vault\'s secrets "aws", "r2": keep it in one of them.',
    );
  });
});
