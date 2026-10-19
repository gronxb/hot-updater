/**
 * The vault's envelope encryption, on WebCrypto only so it runs wherever the
 * server runs: each version of a value is sealed with AES-256-GCM under a
 * fresh 32-byte data key, and the data key is sealed under the master key.
 * Both seals bind the secret's id and version as additional data, so a
 * ciphertext copied to another row no longer opens.
 */

/** The environment variable that holds the master key, 32 bytes in base64. */
export const VAULT_MASTER_KEY_ENV = "HOT_UPDATER_VAULT_MASTER_KEY";

/** The key id stored with versions sealed under the one master key. */
export const DEFAULT_KID = "default";

const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The vault cannot seal or open values: no master key, or not the one a version needs. */
export class VaultLockedError extends Error {
  override readonly name = "VaultLockedError";
}

/** A sealed value did not open: it was altered, or moved from another row. */
export class VaultIntegrityError extends Error {
  override readonly name = "VaultIntegrityError";
}

export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/** Decodes base64 or base64url, padded or not; null when it isn't either. */
export const base64ToBytes = (
  value: string,
): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/u.test(value)) return null;
  const base64 = value
    .replace(/=+$/u, "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  if (base64.length % 4 === 1) return null;
  try {
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const randomBytes = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

/** The AES-GCM additional data that binds a sealed value to its row. */
export const vaultAad = (secretId: string, version: number) =>
  new TextEncoder().encode(`hot-updater-vault/v1|${secretId}|${version}`);

const importAesKey = (raw: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** A master key: its id and the key that wraps data keys. */
export interface VaultMasterKey {
  readonly kid: string;
  readonly key: CryptoKey;
}

/** Imports a master key from its base64 text; throws `VaultLockedError` unless it is 32 bytes. */
export const importMasterKey = async (
  encoded: string,
  kid = DEFAULT_KID,
): Promise<VaultMasterKey> => {
  const raw = base64ToBytes(encoded.trim());
  if (raw === null || raw.byteLength !== KEY_BYTES) {
    throw new VaultLockedError(
      `The vault master key must be ${KEY_BYTES} bytes in base64, such as the output of \`openssl rand -base64 32\`.`,
    );
  }
  return { kid, key: await importAesKey(raw) };
};

/** One sealed version, as `secret_versions` stores it. */
export interface SealedValue {
  readonly kid: string;
  readonly wrapped_dek: string;
  readonly iv: string;
  readonly ciphertext: string;
}

/** Seals `plaintext` for one version of one secret under a new data key. */
export const seal = async (input: {
  readonly masterKey: VaultMasterKey;
  readonly secretId: string;
  readonly version: number;
  readonly plaintext: Uint8Array<ArrayBuffer>;
}): Promise<SealedValue> => {
  const additionalData = vaultAad(input.secretId, input.version);
  const dek = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    await importAesKey(dek),
    input.plaintext,
  );
  const wrapIv = randomBytes(IV_BYTES);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv, additionalData },
    input.masterKey.key,
    dek,
  );
  dek.fill(0);
  const wrappedDek = new Uint8Array(IV_BYTES + wrapped.byteLength);
  wrappedDek.set(wrapIv);
  wrappedDek.set(new Uint8Array(wrapped), IV_BYTES);
  return {
    kid: input.masterKey.kid,
    wrapped_dek: bytesToBase64Url(wrappedDek),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
};

/**
 * Opens one sealed version of one secret. Throws `VaultLockedError` when it
 * was sealed under another master key, and `VaultIntegrityError` when it
 * does not open as this secret's version.
 */
export const open = async (input: {
  readonly masterKey: VaultMasterKey;
  readonly secretId: string;
  readonly version: number;
  readonly sealed: SealedValue;
}): Promise<Uint8Array<ArrayBuffer>> => {
  if (input.sealed.kid !== input.masterKey.kid) {
    throw new VaultLockedError(
      `Version ${input.version} of this secret was sealed under master key "${input.sealed.kid}", which the vault does not have.`,
    );
  }
  const additionalData = vaultAad(input.secretId, input.version);
  const wrappedDek = base64ToBytes(input.sealed.wrapped_dek);
  const iv = base64ToBytes(input.sealed.iv);
  const ciphertext = base64ToBytes(input.sealed.ciphertext);
  if (
    wrappedDek === null ||
    wrappedDek.byteLength <= IV_BYTES ||
    iv === null ||
    iv.byteLength !== IV_BYTES ||
    ciphertext === null
  ) {
    throw new VaultIntegrityError(
      `Version ${input.version} of this secret is not a sealed value.`,
    );
  }
  let dek: Uint8Array<ArrayBuffer> | undefined;
  try {
    dek = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: wrappedDek.subarray(0, IV_BYTES),
          additionalData,
        },
        input.masterKey.key,
        wrappedDek.subarray(IV_BYTES),
      ),
    );
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData },
        await importAesKey(dek),
        ciphertext,
      ),
    );
  } catch {
    throw new VaultIntegrityError(
      `Version ${input.version} of this secret did not decrypt: it was altered or moved from another row, or the master key is not the one that sealed it.`,
    );
  } finally {
    dek?.fill(0);
  }
};
