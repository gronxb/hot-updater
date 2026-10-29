import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import path from "node:path";

/** `sha256:<hex>` of a public key's SPKI DER, as `keys` names keys. */
export const spkiFingerprint = (der: Buffer): string =>
  `sha256:${createHash("sha256").update(der).digest("hex")}`;

/**
 * An existing bundle signing key, read from `file`'s PEM, PKCS#1 or PKCS#8:
 * `pem` is the PKCS#8 PEM local signing reads, as `keys generate` stores
 * it, and `fingerprint` its public key's. Refuses an encrypted key, a key
 * other than RSA, and one under 2048 bits, naming the file by its name.
 */
export const readBundleSigningKey = (
  text: string,
  file: string,
): { readonly pem: string; readonly fingerprint: string } => {
  const name = path.basename(file);
  let key: KeyObject;
  try {
    key = createPrivateKey(text);
  } catch {
    throw new Error(
      text.includes("ENCRYPTED")
        ? `${name} is encrypted. Store the key without a passphrase.`
        : `${name} is not a private key in PEM.`,
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`${name} is not an RSA private key.`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < 2048) {
    throw new Error(
      `${name} is a ${bits}-bit RSA key. Bundle signing needs 2048 bits or more.`,
    );
  }
  return {
    pem: key.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: spkiFingerprint(
      createPublicKey(key).export({ type: "spki", format: "der" }),
    ),
  };
};
