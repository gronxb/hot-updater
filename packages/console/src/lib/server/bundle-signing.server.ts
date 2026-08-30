import { createHash, createPublicKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ConsoleSigningConfig } from "../../index";

const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const DEFAULT_PROVIDER = "Configured provider";
const PUBLIC_KEY_HEADER = "-----BEGIN PUBLIC KEY-----";
const PUBLIC_KEY_FOOTER = "-----END PUBLIC KEY-----";

export type BundleSigningInspection =
  | { readonly status: "disabled" }
  | {
      readonly status: "misconfigured";
      readonly provider: string;
      readonly message: string;
    }
  | {
      readonly status: "enabled";
      readonly provider: string;
      readonly algorithm: "RSA-SHA256";
      readonly fingerprint: string;
      readonly publicKey: string;
    };

const misconfigured = (
  provider: string,
  message: string,
): BundleSigningInspection => ({ message, provider, status: "misconfigured" });

const isSpkiPublicKeyPem = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    trimmed.startsWith(PUBLIC_KEY_HEADER) &&
    trimmed.endsWith(PUBLIC_KEY_FOOTER) &&
    !trimmed.includes("PRIVATE KEY")
  );
};

export const inspectBundleSigning = async (
  signing: ConsoleSigningConfig | undefined,
): Promise<BundleSigningInspection> => {
  if (!signing?.enabled) return { status: "disabled" };

  const provider = signing.provider ?? DEFAULT_PROVIDER;
  if (!signing.publicKeyPath) {
    return misconfigured(provider, "A public key file is not configured.");
  }

  try {
    const publicKeyPath = path.isAbsolute(signing.publicKeyPath)
      ? signing.publicKeyPath
      : path.resolve(process.cwd(), signing.publicKeyPath);
    const publicKeyStat = await stat(publicKeyPath);
    if (!publicKeyStat.isFile() || publicKeyStat.size > MAX_PUBLIC_KEY_BYTES) {
      return misconfigured(
        provider,
        "The configured public key could not be loaded.",
      );
    }

    const publicKeyPem = await readFile(publicKeyPath, "utf8");
    if (!isSpkiPublicKeyPem(publicKeyPem)) {
      return misconfigured(
        provider,
        "The configured public key is not a valid SPKI public key.",
      );
    }

    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "rsa") {
      return misconfigured(
        provider,
        "The configured public key is not an RSA public key.",
      );
    }
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      return misconfigured(
        provider,
        "The configured RSA public key must be at least 2048 bits.",
      );
    }

    const canonicalDer = publicKey.export({ format: "der", type: "spki" });
    const canonicalPem = publicKey.export({ format: "pem", type: "spki" });
    return {
      algorithm: "RSA-SHA256",
      fingerprint: createHash("sha256").update(canonicalDer).digest("hex"),
      provider,
      publicKey: canonicalPem.toString().trim(),
      status: "enabled",
    };
  } catch {
    return misconfigured(
      provider,
      "The configured public key could not be loaded.",
    );
  }
};
