import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as configApi from "./config";
import { packageJsonData } from "./packageJson";

// The modules the secrets adapters load on first use, each recorded when it
// loads: every config load imports the root.
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("execa", async (importOriginal) => {
  loaded.add("execa");
  return importOriginal();
});
vi.mock("tweetnacl", async (importOriginal) => {
  loaded.add("tweetnacl");
  return importOriginal();
});
vi.mock("@noble/hashes/blake2.js", async (importOriginal) => {
  loaded.add("@noble/hashes/blake2.js");
  return importOriginal();
});
vi.mock("aws4fetch", async (importOriginal) => {
  loaded.add("aws4fetch");
  return importOriginal();
});

describe("hot-updater exports", () => {
  it("exposes defineConfig, the fingerprint helpers, and the secrets adapters", () => {
    expect(Object.keys(configApi).sort()).toEqual([
      "awsSecretsManager",
      "createAndInjectFingerprintFiles",
      "createFingerprintJSON",
      "defineConfig",
      "envSecrets",
      "generateFingerprint",
      "generateFingerprints",
      "githubActions",
      "googleSecretManager",
      "infisical",
      "readLocalFingerprint",
      "secretEnv",
    ]);
  });

  it("loads none of the secrets adapters' dependencies with the config", () => {
    configApi.githubActions({ repo: "owner/name" });
    configApi.awsSecretsManager({ region: "us-east-1" });

    expect([...loaded]).toEqual([]);
  });

  it("has no hot-updater/secrets entry: the secrets adapters are root exports", () => {
    const { exports } = packageJsonData as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(exports).sort()).toEqual([
      ".",
      "./package.json",
      "./plugins",
      "./signing",
    ]);
  });

  it("reads envSecrets() from the environment, read-only", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-env-"));
    process.env["HOT_UPDATER_SPEC_RELEASE_KEYSTORE"] = '{"keystore":"a"}';
    try {
      const secrets = configApi.envSecrets();

      await expect(
        secrets.get(["spec-release-keystore", "SPEC_UNSET_NAME"], { cwd }),
      ).resolves.toEqual({
        "spec-release-keystore": '{"keystore":"a"}',
        SPEC_UNSET_NAME: undefined,
      });
      expect(secrets.name).toBe("envSecrets");
      expect(secrets.set).toBeUndefined();
    } finally {
      delete process.env["HOT_UPDATER_SPEC_RELEASE_KEYSTORE"];
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
