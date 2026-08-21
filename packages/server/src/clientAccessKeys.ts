import type {
  ClientAccessKeyRow,
  ClientAccessKeyModel,
} from "@hot-updater/plugin-core";

export const CLIENT_ACCESS_KEY_HEADER_NAME = "x-api-key";

const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const isClientAccessKey = (value: string): boolean => {
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

export const normalizeClientAccessKeyHeaderName = (
  value: unknown = CLIENT_ACCESS_KEY_HEADER_NAME,
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

export const hashClientAccessKey = async (apiKey: string): Promise<string> => {
  if (!isClientAccessKey(apiKey)) {
    throw new TypeError(
      "Client access key must be a canonical 32-byte base64url value.",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey),
  );
  return bytesToBase64Url(new Uint8Array(digest));
};

export const clientAccessKeyId = (hash: string): string => `client-${hash}`;

export const normalizeClientAccessKeyName = (name: string): string => {
  const normalized = name.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new TypeError(
      "Client access-key names must contain 1-64 visible characters.",
    );
  }
  return normalized;
};

export interface CreatedClientAccessKey {
  readonly apiKey: string;
  readonly record: ClientAccessKeyRow;
}

export const registerClientAccessKey = async (input: {
  readonly apiKey: string;
  readonly clientAccessKeys: ClientAccessKeyModel;
  readonly createdAtMs?: number;
  readonly name: string;
}): Promise<CreatedClientAccessKey> => {
  const hash = await hashClientAccessKey(input.apiKey);
  const createdAtMs = input.createdAtMs ?? Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new TypeError(
      "Client access-key creation time must be non-negative.",
    );
  }
  const record = Object.freeze({
    created_at_ms: createdAtMs,
    hash,
    id: clientAccessKeyId(hash),
    name: normalizeClientAccessKeyName(input.name),
    prefix: input.apiKey.slice(0, 6),
    revoked_at_ms: null,
    role: "client" as const,
  });
  const status = await input.clientAccessKeys.create(record);
  if (status === "existing") {
    const existing = await input.clientAccessKeys.findByHash(hash);
    if (existing === null || existing.revoked_at_ms !== null) {
      throw new Error("The client access key has been revoked.");
    }
    return Object.freeze({ apiKey: input.apiKey, record: existing });
  }
  return Object.freeze({ apiKey: input.apiKey, record });
};

export const createClientAccessKey = (input: {
  readonly clientAccessKeys: ClientAccessKeyModel;
  readonly name: string;
}): Promise<CreatedClientAccessKey> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return registerClientAccessKey({
    apiKey: bytesToBase64Url(bytes),
    clientAccessKeys: input.clientAccessKeys,
    name: input.name,
  });
};

export const authenticateClientAccessKey = async (input: {
  readonly beforeLookup?: () => Promise<void>;
  readonly clientAccessKeys: ClientAccessKeyModel;
  readonly headerName?: string;
  readonly request: Request;
}): Promise<boolean> => {
  const apiKey = input.request.headers.get(
    normalizeClientAccessKeyHeaderName(input.headerName),
  );
  if (apiKey === null || !isClientAccessKey(apiKey)) return false;
  const hash = await hashClientAccessKey(apiKey);
  await input.beforeLookup?.();
  const record = await input.clientAccessKeys.findByHash(hash);
  return (
    record !== null &&
    record.hash === hash &&
    record.role === "client" &&
    record.revoked_at_ms === null
  );
};
