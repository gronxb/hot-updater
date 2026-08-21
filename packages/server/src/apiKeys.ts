import type { ApiKeyModel, ApiKeyRow } from "@hot-updater/plugin-core";

export const API_KEY_HEADER_NAME = "x-api-key";

const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const isApiKey = (value: string): boolean => {
  if (!BASE64URL_32_PATTERN.test(value)) return false;

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(`${base64}=`);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return bytes.byteLength === 32 && bytesToBase64Url(bytes) === value;
  } catch {
    return false;
  }
};

export const normalizeApiKeyHeaderName = (
  value: unknown = API_KEY_HEADER_NAME,
): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("clientAccess.headerName must be a valid header name.");
  }

  try {
    const headers = new Headers();
    headers.set(value, "");
    return headers.keys().next().value!;
  } catch {
    throw new TypeError("clientAccess.headerName must be a valid header name.");
  }
};

export const hashApiKey = async (apiKey: string): Promise<string> => {
  if (!isApiKey(apiKey)) {
    throw new TypeError("API key must be a canonical 32-byte base64url value.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey),
  );
  return bytesToBase64Url(new Uint8Array(digest));
};

export const apiKeyId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `api-${bytesToBase64Url(bytes)}`;
};

export const normalizeApiKeyName = (name: string): string => {
  const normalized = name.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new TypeError("API key names must contain 1-64 visible characters.");
  }
  return normalized;
};

export type ApiKeyMetadata = Omit<ApiKeyRow, "hash">;

export interface CreatedApiKey {
  /** Plaintext credential. It cannot be recovered after this call returns. */
  readonly apiKey: string;
  /** Non-secret metadata. The persisted SHA-256 hash is never exposed. */
  readonly record: ApiKeyMetadata;
}

export interface ApiKeyManagementAPI {
  /** Creates an API key and returns its plaintext exactly once. */
  create(input: { readonly name: string }): Promise<{
    readonly apiKey: string;
    readonly record: ApiKeyMetadata;
  }>;
  /** Lists non-secret API key metadata, including revoked keys. */
  list(): Promise<readonly ApiKeyMetadata[]>;
  /** Revokes an API key immediately and returns only non-secret metadata. */
  revoke(input: { readonly id: string }): Promise<ApiKeyMetadata | null>;
}

const toApiKeyMetadata = ({
  hash: _hash,
  ...metadata
}: ApiKeyRow): ApiKeyMetadata => Object.freeze(metadata);

export const registerApiKey = async (input: {
  readonly apiKey: string;
  readonly apiKeys: ApiKeyModel;
  readonly createdAtMs?: number;
  readonly name: string;
}): Promise<CreatedApiKey> => {
  const hash = await hashApiKey(input.apiKey);
  const createdAtMs = input.createdAtMs ?? Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new TypeError("API key creation time must be non-negative.");
  }
  const record = Object.freeze({
    created_at_ms: createdAtMs,
    hash,
    id: apiKeyId(),
    name: normalizeApiKeyName(input.name),
    prefix: input.apiKey.slice(0, 6),
    revoked_at_ms: null,
    role: "client" as const,
  });
  const status = await input.apiKeys.create(record);
  if (status === "existing") {
    const existing = await input.apiKeys.findByHash(hash);
    if (existing === null || existing.revoked_at_ms !== null) {
      throw new Error("The API key has been revoked.");
    }
    return Object.freeze({
      apiKey: input.apiKey,
      record: toApiKeyMetadata(existing),
    });
  }
  return Object.freeze({
    apiKey: input.apiKey,
    record: toApiKeyMetadata(record),
  });
};

export const createApiKey = (input: {
  readonly apiKeys: ApiKeyModel;
  readonly name: string;
}): Promise<CreatedApiKey> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return registerApiKey({
    apiKey: bytesToBase64Url(bytes),
    apiKeys: input.apiKeys,
    name: input.name,
  });
};

export const authenticateApiKey = async (input: {
  readonly beforeLookup?: () => Promise<void>;
  readonly apiKeys: ApiKeyModel;
  readonly headerName?: string;
  readonly request: Request;
}): Promise<boolean> => {
  const apiKey = input.request.headers.get(
    normalizeApiKeyHeaderName(input.headerName),
  );
  if (apiKey === null || !isApiKey(apiKey)) return false;
  const hash = await hashApiKey(apiKey);
  await input.beforeLookup?.();
  const record = await input.apiKeys.findByHash(hash);
  return (
    record !== null &&
    record.hash === hash &&
    record.role === "client" &&
    record.revoked_at_ms === null
  );
};

export const createApiKeyManagement = (input: {
  readonly apiKeys: ApiKeyModel;
  readonly beforeOperation: () => Promise<void>;
}): ApiKeyManagementAPI =>
  Object.freeze({
    async create({ name }: { readonly name: string }) {
      await input.beforeOperation();
      const created = await createApiKey({ apiKeys: input.apiKeys, name });
      return Object.freeze({
        apiKey: created.apiKey,
        record: created.record,
      });
    },
    async list() {
      await input.beforeOperation();
      return Object.freeze((await input.apiKeys.list()).map(toApiKeyMetadata));
    },
    async revoke({ id }: { readonly id: string }) {
      await input.beforeOperation();
      const record = await input.apiKeys.revoke({
        id,
        revokedAtMs: Date.now(),
      });
      return record === null ? null : toApiKeyMetadata(record);
    },
  });
