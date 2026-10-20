import { generateKeyPairSync, type KeyObject } from "node:crypto";

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

  it("takes an RSA bundle signing key in PEM, PKCS#8 or PKCS#1, and shows nothing of it", () => {
    for (const [modulusLength, type] of [
      [2048, "pkcs8"],
      [3072, "pkcs1"],
      [4096, "pkcs8"],
    ] as const) {
      const privateKey = base64(
        generateKeyPairSync("rsa", { modulusLength })
          .privateKey.export({ format: "pem", type })
          .toString(),
      );
      const value = parseVaultSecretValue("bundle-signing-key", {
        privateKey,
      });
      expect(value).toEqual({ privateKey });
      expect(vaultSecretMetadata("bundle-signing-key", value)).toEqual({});
    }
  });

  it("refuses a bundle signing key the Console cannot sign with", () => {
    const pkcs8 = (key: KeyObject) =>
      key.export({ format: "pem", type: "pkcs8" }).toString();
    // A PKCS#8 key whose PrivateKeyInfo version is 2, not 0.
    const der = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ format: "der", type: "pkcs8" });
    der[der.indexOf(Buffer.from([0x02, 0x01, 0x00]))! + 2] = 2;
    const versionTwo = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
    // A valid key's PrivateKeyInfo with a 0x00 byte after its key.
    const valid = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ format: "der", type: "pkcs8" });
    const trailing = Buffer.concat([valid, Buffer.from([0x00])]);
    trailing.writeUInt16BE(valid.readUInt16BE(2) + 1, 2);
    const trailingByte = `-----BEGIN PRIVATE KEY-----\n${trailing.toString("base64")}\n-----END PRIVATE KEY-----\n`;
    for (const pem of [
      versionTwo,
      trailingByte,
      pkcs8(generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey),
      pkcs8(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey),
      pkcs8(generateKeyPairSync("ed25519").privateKey),
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({
          format: "pem",
          type: "pkcs8",
          cipher: "aes-256-cbc",
          passphrase: "secret",
        })
        .toString(),
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
      // A 2048-bit modulus with every other value 1, such as e = 1.
      `-----BEGIN RSA PRIVATE KEY-----\n${Buffer.from([
        0x30,
        0x82,
        0x01,
        0x1d,
        0x02,
        0x01,
        0x00,
        0x02,
        0x82,
        0x01,
        0x01,
        0x00,
        ...Array.from({ length: 256 }, () => 0xff),
        ...Array.from({ length: 7 }, () => [0x02, 0x01, 0x01]).flat(),
      ]).toString("base64")}\n-----END RSA PRIVATE KEY-----\n`,
      // A PKCS#1 sequence of only the version and a 2048-bit modulus.
      `-----BEGIN RSA PRIVATE KEY-----\n${Buffer.from([
        0x30,
        0x82,
        0x01,
        0x08,
        0x02,
        0x01,
        0x00,
        0x02,
        0x82,
        0x01,
        0x01,
        0x00,
        ...Array.from({ length: 256 }, () => 0xff),
      ]).toString("base64")}\n-----END RSA PRIVATE KEY-----\n`,
    ]) {
      expect(() =>
        parseVaultSecretValue("bundle-signing-key", {
          privateKey: base64(pem),
        }),
      ).toThrow(
        "A secret of kind bundle-signing-key has privateKey as an unencrypted RSA private key of 2048, 3072, or 4096 bits in PEM",
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
