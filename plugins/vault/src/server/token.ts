import { bytesToBase64Url } from "./crypto";

/**
 * Vault tokens' key material, copied from the api-keys plugin, which exports
 * none: a token is `hu_vault_` and 32 random bytes in base64url, and the
 * database keeps only its SHA-256 digest.
 */
export const VAULT_TOKEN_PREFIX = "hu_vault_";

const VAULT_TOKEN_PATTERN = /^hu_vault_[A-Za-z0-9_-]{43}$/u;

/** A new vault token in plaintext. */
export const generateVaultToken = (): string =>
  `${VAULT_TOKEN_PREFIX}${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

export const isVaultToken = (value: string): boolean =>
  VAULT_TOKEN_PATTERN.test(value);

/** The SHA-256 digest of a token in base64url, as `tokens.hash` stores it. */
export const hashVaultToken = async (token: string): Promise<string> => {
  if (!isVaultToken(token)) {
    throw new TypeError(
      `A vault token is ${VAULT_TOKEN_PREFIX} and 32 bytes in base64url.`,
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return bytesToBase64Url(new Uint8Array(digest));
};

/** A new row id, `prefix` and 16 random bytes in base64url. */
export const randomId = (prefix: string): string =>
  `${prefix}-${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
