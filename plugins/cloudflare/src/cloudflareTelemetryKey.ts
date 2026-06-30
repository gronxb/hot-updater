import {
  type CloudflareTelemetryD1Database,
  queryFirst,
  runD1,
} from "./cloudflareTelemetryD1";

export const CLOUDFLARE_TELEMETRY_KEY_PREFIX = "hutk_";
export const CLOUDFLARE_TELEMETRY_KEY_HEADER = "x-hot-updater-telemetry-key";
export const CLOUDFLARE_TELEMETRY_KEY_SUFFIX_LENGTH = 8;

export type CloudflareTelemetryKeyResponse = {
  readonly telemetryKey: string;
  readonly telemetryKeySuffix: string;
};

export type CloudflareTelemetryKeyState = {
  readonly telemetryKeySuffix: string;
};

export type CloudflareTelemetryCredentialResult =
  | {
      readonly kind: "accepted";
      readonly telemetryKey: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "invalid_credential_channel" | "missing_or_invalid";
    };

type TelemetryKeyRow = {
  readonly key_hash: string;
  readonly key_suffix: string;
};

const TELEMETRY_KEY_ROW_ID = "default";

const createTelemetryKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${CLOUDFLARE_TELEMETRY_KEY_PREFIX}${random}`;
};

const keySuffix = (telemetryKey: string): string =>
  telemetryKey.slice(-CLOUDFLARE_TELEMETRY_KEY_SUFFIX_LENGTH);

const digestHex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const safeEqual = (left: string, right: string): boolean => {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
};

const isTelemetryKeyShape = (value: string | null): value is string =>
  typeof value === "string" &&
  value.startsWith(CLOUDFLARE_TELEMETRY_KEY_PREFIX) &&
  value.length > CLOUDFLARE_TELEMETRY_KEY_PREFIX.length;

const hasQueryCredential = (url: URL): boolean =>
  url.searchParams.has("telemetryKey") ||
  url.searchParams.has("telemetry_key") ||
  url.searchParams.has(CLOUDFLARE_TELEMETRY_KEY_HEADER);

export const readCloudflareTelemetryCredential = (
  request: Request,
): CloudflareTelemetryCredentialResult => {
  const url = new URL(request.url);
  if (
    request.headers.has("authorization") ||
    request.headers.has("cookie") ||
    hasQueryCredential(url)
  ) {
    return { kind: "rejected", reason: "invalid_credential_channel" };
  }

  const telemetryKey = request.headers.get(CLOUDFLARE_TELEMETRY_KEY_HEADER);
  if (!isTelemetryKeyShape(telemetryKey)) {
    return { kind: "rejected", reason: "missing_or_invalid" };
  }

  return { kind: "accepted", telemetryKey };
};

export const issueCloudflareTelemetryKey = async (
  db: CloudflareTelemetryD1Database,
): Promise<CloudflareTelemetryKeyResponse> => {
  const telemetryKey = createTelemetryKey();
  const now = new Date().toISOString();
  await runD1(
    db,
    `
      INSERT INTO telemetry_keys (id, key_hash, key_suffix, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key_hash = excluded.key_hash,
        key_suffix = excluded.key_suffix,
        updated_at = excluded.updated_at
    `,
    [
      TELEMETRY_KEY_ROW_ID,
      await digestHex(telemetryKey),
      keySuffix(telemetryKey),
      now,
      now,
    ],
  );

  return {
    telemetryKey,
    telemetryKeySuffix: keySuffix(telemetryKey),
  };
};

export const rotateCloudflareTelemetryKey = issueCloudflareTelemetryKey;

export const getCloudflareTelemetryKeyState = async (
  db: CloudflareTelemetryD1Database,
): Promise<CloudflareTelemetryKeyState | null> => {
  const row = await queryFirst<TelemetryKeyRow>(
    db,
    "SELECT key_suffix FROM telemetry_keys WHERE id = ? LIMIT 1",
    [TELEMETRY_KEY_ROW_ID],
  );
  return row ? { telemetryKeySuffix: row.key_suffix } : null;
};

export const authenticateCloudflareTelemetryKey = async (
  db: CloudflareTelemetryD1Database,
  telemetryKey: string,
): Promise<boolean> => {
  if (!isTelemetryKeyShape(telemetryKey)) {
    return false;
  }

  const row = await queryFirst<TelemetryKeyRow>(
    db,
    "SELECT key_hash, key_suffix FROM telemetry_keys WHERE id = ? LIMIT 1",
    [TELEMETRY_KEY_ROW_ID],
  );
  if (!row || keySuffix(telemetryKey) !== row.key_suffix) {
    return false;
  }

  return safeEqual(await digestHex(telemetryKey), row.key_hash);
};
