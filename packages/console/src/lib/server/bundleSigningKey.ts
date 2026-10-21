/**
 * A vault `bundle-signing-key` opened for signing with WebCrypto alone, so
 * the console signs on every runtime it deploys to, Workers included.
 */
export interface BundleSigningKey {
  /** The SPKI public key in PEM, which `createBundleSigningHandler` serves. */
  readonly publicKey: string;
  /** RSA PKCS#1 v1.5 with SHA-256 over `message`, the bundle signing protocol. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const PEM_PATTERN =
  /-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END \1?PRIVATE KEY-----/u;

/** `rsaEncryption` with NULL parameters, the PKCS#8 algorithm of an RSA key. */
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

/** A PKCS#1 `RSAPrivateKey` in the PKCS#8 envelope WebCrypto imports. */
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const body = [
    0x02,
    0x01,
    0x00,
    ...RSA_ALGORITHM_IDENTIFIER,
    0x04,
    ...derLength(pkcs1.byteLength),
  ];
  return new Uint8Array([
    0x30,
    ...derLength(body.length + pkcs1.byteLength),
    ...body,
    ...pkcs1,
  ]);
};

const base64ToBytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

/** A signing key the console cannot sign with; the message holds none of its bytes. */
export class BundleSigningKeyError extends Error {
  override readonly name = "BundleSigningKeyError";
}

/**
 * Opens a `bundle-signing-key` value, `{ privateKey }` with the PEM file in
 * base64, as PKCS#8 or PKCS#1. Throws `BundleSigningKeyError` when it holds
 * no unencrypted RSA private key of 2048, 3072, or 4096 bits, the sizes the
 * signing protocol takes.
 */
export const openBundleSigningKey = async (
  value: unknown,
): Promise<BundleSigningKey> => {
  const encoded =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "privateKey")
      : undefined;
  let privateKey: CryptoKey;
  try {
    if (typeof encoded !== "string") throw new TypeError();
    const match = PEM_PATTERN.exec(atob(encoded));
    if (match === null) throw new TypeError();
    const der = base64ToBytes(match[2]!.replaceAll(/\s/gu, ""));
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(match[1] === undefined ? der : pkcs1ToPkcs8(der)).buffer,
      ALGORITHM,
      true,
      ["sign"],
    );
  } catch {
    throw new BundleSigningKeyError(
      "holds no unencrypted RSA private key in PEM",
    );
  }
  const { modulusLength } = privateKey.algorithm as RsaHashedKeyAlgorithm;
  if (![2048, 3072, 4096].includes(modulusLength)) {
    throw new BundleSigningKeyError(
      `is a ${modulusLength}-bit RSA key, not 2048, 3072, or 4096 bits`,
    );
  }
  // The public half is the private key's modulus and exponent.
  const { n, e } = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n, e, ext: true },
    ALGORITHM,
    true,
    ["verify"],
  );
  const spki = bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)),
  );
  const lines = spki.match(/.{1,64}/gu) ?? [];
  return {
    publicKey: `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`,
    sign: async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          ALGORITHM,
          privateKey,
          new Uint8Array(message).buffer,
        ),
      ),
  };
};
