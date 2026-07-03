import {
  createDatabaseAnalyticsRuntime,
  type TelemetryKeyCredential,
  type TelemetryKeyResult,
  type TelemetryKeyState,
} from "@hot-updater/plugin-core";

import {
  type CloudflareTelemetryD1Database,
  queryFirst,
  runD1,
} from "./cloudflareTelemetryD1";

export const CLOUDFLARE_TELEMETRY_KEY_PREFIX = "hutk_";
export const CLOUDFLARE_TELEMETRY_KEY_HEADER = "x-hot-updater-telemetry-key";
export const CLOUDFLARE_TELEMETRY_KEY_SUFFIX_LENGTH = 8;

export type CloudflareTelemetryKeyResponse = TelemetryKeyResult;

export type CloudflareTelemetryKeyState = TelemetryKeyState;

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
  readonly active: number;
  readonly key_hash: string;
  readonly key_suffix: string;
};

class CloudflareTelemetryRuntimeConfigurationError extends Error {
  constructor(capability: "reads" | "writes") {
    super(`Cloudflare telemetry key ${capability} are not configured.`);
    this.name = "CloudflareTelemetryRuntimeConfigurationError";
  }
}

const TELEMETRY_KEY_ROW_ID = "default";

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

export const getCloudflareTelemetryKeyCredential = async (
  db: CloudflareTelemetryD1Database,
): Promise<TelemetryKeyCredential | null> => {
  const row = await queryFirst<TelemetryKeyRow>(
    db,
    "SELECT active, key_hash, key_suffix FROM ingest_keys WHERE id = ? LIMIT 1",
    [TELEMETRY_KEY_ROW_ID],
  );
  return row
    ? {
        active: row.active === 1,
        keyHash: row.key_hash,
        telemetryKeySuffix: row.key_suffix,
      }
    : null;
};

export const upsertCloudflareTelemetryKeyCredential = async (
  db: CloudflareTelemetryD1Database,
  credential: TelemetryKeyCredential,
): Promise<void> => {
  const now = new Date().toISOString();
  await runD1(
    db,
    `
      INSERT INTO ingest_keys (
        id,
        key_hash,
        key_suffix,
        active,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key_hash = excluded.key_hash,
        key_suffix = excluded.key_suffix,
        active = excluded.active,
        updated_at = excluded.updated_at
    `,
    [
      TELEMETRY_KEY_ROW_ID,
      credential.keyHash,
      credential.telemetryKeySuffix,
      credential.active ? 1 : 0,
      now,
      now,
    ],
  );
};

export const setCloudflareTelemetryKeyActive = async (
  db: CloudflareTelemetryD1Database,
  active: boolean,
): Promise<void> => {
  await runD1(
    db,
    `
      UPDATE ingest_keys
      SET active = ?, updated_at = ?
      WHERE id = ?
    `,
    [active ? 1 : 0, new Date().toISOString(), TELEMETRY_KEY_ROW_ID],
  );
};

const createCloudflareTelemetryRuntime = (db: CloudflareTelemetryD1Database) =>
  createDatabaseAnalyticsRuntime({
    getTelemetryKeyCredential: () => getCloudflareTelemetryKeyCredential(db),
    setTelemetryKeyActive: (active) =>
      setCloudflareTelemetryKeyActive(db, active),
    upsertTelemetryKeyCredential: (credential) =>
      upsertCloudflareTelemetryKeyCredential(db, credential),
  });

export const issueCloudflareTelemetryKey = async (
  db: CloudflareTelemetryD1Database,
): Promise<CloudflareTelemetryKeyResponse> => {
  const runtime = createCloudflareTelemetryRuntime(db);
  if (!runtime.issueTelemetryKey) {
    throw new CloudflareTelemetryRuntimeConfigurationError("writes");
  }

  return runtime.issueTelemetryKey();
};

export const rotateCloudflareTelemetryKey = async (
  db: CloudflareTelemetryD1Database,
): Promise<CloudflareTelemetryKeyResponse> => {
  const runtime = createCloudflareTelemetryRuntime(db);
  if (!runtime.rotateTelemetryKey) {
    throw new CloudflareTelemetryRuntimeConfigurationError("writes");
  }

  return runtime.rotateTelemetryKey();
};

export const getCloudflareTelemetryKeyState = async (
  db: CloudflareTelemetryD1Database,
): Promise<CloudflareTelemetryKeyState | null> => {
  const runtime = createCloudflareTelemetryRuntime(db);
  if (!runtime.getTelemetryKeyState) {
    throw new CloudflareTelemetryRuntimeConfigurationError("reads");
  }

  return runtime.getTelemetryKeyState();
};

export const setCloudflareTelemetryKeyActiveState = async (
  db: CloudflareTelemetryD1Database,
  active: boolean,
): Promise<void> => {
  const runtime = createCloudflareTelemetryRuntime(db);
  if (!runtime.setTelemetryKeyActive) {
    throw new CloudflareTelemetryRuntimeConfigurationError("writes");
  }

  await runtime.setTelemetryKeyActive(active);
};

export const authenticateCloudflareTelemetryKey = async (
  db: CloudflareTelemetryD1Database,
  telemetryKey: string,
): Promise<boolean> => {
  const runtime = createCloudflareTelemetryRuntime(db);
  if (!runtime.authenticateTelemetryKey) {
    throw new CloudflareTelemetryRuntimeConfigurationError("reads");
  }

  return runtime.authenticateTelemetryKey(telemetryKey);
};
