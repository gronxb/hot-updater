// @vitest-environment node

import {
  parseVaultSecretValue,
  VAULT_MAX_VALUE_BYTES,
  VAULT_SECRET_KINDS,
  VAULT_TOKEN_ACTIONS,
} from "@hot-updater/server/plugins";
import { describe, expect, it } from "vitest";

import {
  ascKeyIdFromFileName,
  buildVaultValue,
  fileToBase64,
  actionsReachKind,
  OFFERED_TOKEN_ACTIONS,
  VAULT_SECRET_KIND_IDS,
  VAULT_VALUE_LIMIT_BYTES,
  vaultSecretKinds,
  vaultTokenActions,
  vaultTokenState,
} from "./vault-secrets";

describe("vault secrets in the console", () => {
  it("offers the vault's kinds and limit", () => {
    expect([...VAULT_SECRET_KIND_IDS].sort()).toEqual(
      [...VAULT_SECRET_KINDS].sort(),
    );
    expect(Object.keys(vaultSecretKinds).sort()).toEqual(
      [...VAULT_SECRET_KINDS].sort(),
    );
    expect(VAULT_VALUE_LIMIT_BYTES).toBe(VAULT_MAX_VALUE_BYTES);
  });

  it("describes every token action the vault defines, offering only those it serves", () => {
    expect(Object.keys(vaultTokenActions).sort()).toEqual(
      [...VAULT_TOKEN_ACTIONS].sort(),
    );
    expect(OFFERED_TOKEN_ACTIONS).toEqual(["read", "sign", "write"]);
  });

  it("reaches signing keys only with sign or write, and only them with sign", () => {
    expect(actionsReachKind(["read"], "bundle-signing-key")).toBe(false);
    expect(actionsReachKind(["read"], "asc-api-key")).toBe(true);
    expect(actionsReachKind(["sign"], "bundle-signing-key")).toBe(true);
    expect(actionsReachKind(["sign"], "asc-api-key")).toBe(false);
    expect(actionsReachKind(["write"], "bundle-signing-key")).toBe(true);
    expect(actionsReachKind(["read", "sign"], "asc-api-key")).toBe(true);
    expect(actionsReachKind([], "asc-api-key")).toBe(true);
    expect(actionsReachKind([], "bundle-signing-key")).toBe(false);
  });

  it("builds a value the vault takes from each kind's fields", () => {
    const p8 = btoa(
      "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----",
    );
    const value = buildVaultValue("asc-api-key", {
      fields: { p8, keyId: "ABC123", issuerId: "issuer", extra: "x" },
      variables: [],
    });

    expect(value).toEqual({ p8, keyId: "ABC123", issuerId: "issuer" });
    expect(parseVaultSecretValue("asc-api-key", value)).toEqual(value);
  });

  it("builds a key/value secret from its rows, skipping empty ones", () => {
    expect(
      buildVaultValue("deploy-credentials", {
        fields: {},
        variables: [
          { name: " R2_SECRET ", value: "s" },
          { name: "", value: "" },
        ],
      }),
    ).toEqual({ R2_SECRET: "s" });
  });

  it("reads a file as base64", async () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 256);

    const encoded = await fileToBase64(new Blob([bytes]));

    expect(Buffer.from(encoded, "base64").equals(Buffer.from(bytes))).toBe(
      true,
    );
  });

  it("finds the key ID in an App Store Connect key's file name", () => {
    expect(ascKeyIdFromFileName("AuthKey_ABC123DEFG.p8")).toBe("ABC123DEFG");
    expect(ascKeyIdFromFileName("key.p8")).toBeUndefined();
  });

  it("tells active, revoked, and expired tokens apart", () => {
    expect(vaultTokenState({ expiresAtMs: null, revokedAtMs: null }, 5)).toBe(
      "active",
    );
    expect(vaultTokenState({ expiresAtMs: 5, revokedAtMs: null }, 5)).toBe(
      "expired",
    );
    expect(vaultTokenState({ expiresAtMs: 9, revokedAtMs: 1 }, 5)).toBe(
      "revoked",
    );
  });
});
