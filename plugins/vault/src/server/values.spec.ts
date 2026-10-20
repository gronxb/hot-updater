import { describe, expect, it } from "vitest";

import { VaultInputError } from "./api";
import { parseVaultSecretValue, vaultSecretMetadata } from "./values";

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const P8 = base64(
  "-----BEGIN PRIVATE KEY-----\nMIGTAgEA\n-----END PRIVATE KEY-----\n",
);
const SERVICE_ACCOUNT = base64(
  JSON.stringify({
    type: "service_account",
    project_id: "demo",
    client_email: "ci@demo.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\n...",
  }),
);

describe("parseVaultSecretValue", () => {
  it("takes an App Store Connect key and trims its ids", () => {
    const value = parseVaultSecretValue("asc-api-key", {
      p8: P8,
      keyId: " ABC123 ",
      issuerId: "issuer",
    });

    expect(value).toEqual({ p8: P8, keyId: "ABC123", issuerId: "issuer" });
    expect(vaultSecretMetadata("asc-api-key", value)).toEqual({
      keyId: "ABC123",
      issuerId: "issuer",
    });
  });

  it("refuses a .p8 that is not a private key", () => {
    expect(() =>
      parseVaultSecretValue("asc-api-key", {
        p8: base64("hello"),
        keyId: "ABC123",
        issuerId: "issuer",
      }),
    ).toThrow(
      new VaultInputError(
        "A secret of kind asc-api-key has p8 as a .p8 private key.",
      ),
    );
  });

  it("keeps a keystore's passwords as typed and shows only its alias", () => {
    const value = parseVaultSecretValue("android-keystore", {
      keystore: btoa("\u0000\u0001binary"),
      storePassword: " store ",
      keyAlias: " upload ",
      keyPassword: "key ",
    });

    expect(value).toMatchObject({
      storePassword: " store ",
      keyAlias: "upload",
      keyPassword: "key ",
    });
    expect(vaultSecretMetadata("android-keystore", value)).toEqual({
      keyAlias: "upload",
    });
  });

  it("names the field a value is missing", () => {
    expect(() =>
      parseVaultSecretValue("android-keystore", {
        keystore: btoa("x"),
        storePassword: "store",
        keyAlias: "upload",
      }),
    ).toThrow("A secret of kind android-keystore needs keyPassword.");
    expect(() =>
      parseVaultSecretValue("android-keystore", {
        keystore: "not base64!",
        storePassword: "store",
        keyAlias: "upload",
        keyPassword: "key",
      }),
    ).toThrow(
      "A secret of kind android-keystore has keystore as a file in base64.",
    );
  });

  it("takes a service account's JSON key and shows its email and project", () => {
    const value = parseVaultSecretValue("play-service-account", {
      serviceAccount: SERVICE_ACCOUNT,
    });

    expect(vaultSecretMetadata("play-service-account", value)).toEqual({
      clientEmail: "ci@demo.iam.gserviceaccount.com",
      projectId: "demo",
    });
    expect(() =>
      parseVaultSecretValue("play-service-account", {
        serviceAccount: base64(JSON.stringify({ type: "authorized_user" })),
      }),
    ).toThrow(VaultInputError);
  });

  it("takes a bundle signing key in PEM and shows nothing of it", () => {
    const privateKey = base64(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
    );
    const value = parseVaultSecretValue("bundle-signing-key", { privateKey });

    expect(value).toEqual({ privateKey });
    expect(vaultSecretMetadata("bundle-signing-key", value)).toEqual({});
    for (const label of ["ENCRYPTED PRIVATE KEY", "EC PRIVATE KEY"]) {
      expect(() =>
        parseVaultSecretValue("bundle-signing-key", {
          privateKey: base64(
            `-----BEGIN ${label}-----\nMIIE\n-----END ${label}-----\n`,
          ),
        }),
      ).toThrow(
        "A secret of kind bundle-signing-key has privateKey as an unencrypted RSA private key in PEM",
      );
    }
  });

  it("takes key/value secrets by environment variable name and shows the names", () => {
    const value = parseVaultSecretValue("deploy-credentials", {
      R2_SECRET: "b",
      R2_ACCESS_KEY: "a",
    });

    expect(vaultSecretMetadata("deploy-credentials", value)).toEqual({
      variables: ["R2_ACCESS_KEY", "R2_SECRET"],
    });
    expect(() => parseVaultSecretValue("generic", {})).toThrow(
      "A secret of kind generic has at least one variable.",
    );
    expect(() => parseVaultSecretValue("generic", { "1BAD": "x" })).toThrow(
      VaultInputError,
    );
    expect(() => parseVaultSecretValue("generic", { GOOD: 1 })).toThrow(
      "The variable GOOD has a text value.",
    );
  });

  it("refuses an unknown kind", () => {
    expect(() =>
      parseVaultSecretValue("ssh-key" as "generic", { A: "b" }),
    ).toThrow('"ssh-key" is not a secret kind.');
  });
});
