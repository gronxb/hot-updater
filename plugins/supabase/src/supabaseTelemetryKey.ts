import {
  TELEMETRY_KEY_PREFIX,
  TELEMETRY_KEY_ROW_ID,
  TELEMETRY_KEY_SUFFIX_LENGTH,
  createSupabaseError,
  type SupabaseTelemetryClient,
  type TelemetryKeyResponse,
} from "./supabaseTelemetryTypes";

const createTelemetryKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const entropy = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${TELEMETRY_KEY_PREFIX}${entropy}`;
};

export const hashTelemetryKey = async (
  telemetryKey: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(telemetryKey),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const assertTelemetryKeyShape = (telemetryKey: string): boolean =>
  telemetryKey.startsWith(TELEMETRY_KEY_PREFIX) &&
  telemetryKey.length > TELEMETRY_KEY_PREFIX.length;

export const createKeyResponse = async (
  supabase: SupabaseTelemetryClient,
): Promise<TelemetryKeyResponse> => {
  const telemetryKey = createTelemetryKey();
  const telemetryKeySuffix = telemetryKey.slice(-TELEMETRY_KEY_SUFFIX_LENGTH);
  const keyHash = await hashTelemetryKey(telemetryKey);
  const { error } = await supabase.from("telemetry_keys").upsert(
    {
      id: TELEMETRY_KEY_ROW_ID,
      key_hash: keyHash,
      key_suffix: telemetryKeySuffix,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) throw createSupabaseError("Failed to store telemetry key", error);

  return { telemetryKey, telemetryKeySuffix };
};
