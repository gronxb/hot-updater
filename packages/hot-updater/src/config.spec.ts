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

describe("hot-updater exports", () => {
  it("exposes defineConfig, the fingerprint helpers, secretEnv, and localSecrets(), the one built-in secrets adapter", () => {
    expect(Object.keys(configApi).sort()).toEqual([
      "createAndInjectFingerprintFiles",
      "createFingerprintJSON",
      "defineConfig",
      "generateFingerprint",
      "generateFingerprints",
      "localSecrets",
      "readLocalFingerprint",
      "secretEnv",
    ]);
  });

  it("loads none of the GitHub secret writer's dependencies with the config", () => {
    configApi.localSecrets();

    expect([...loaded]).toEqual([]);
  });

  it("has no hot-updater/secrets entry: localSecrets() is a root export", () => {
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
});
