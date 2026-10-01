export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUUIDv7 = (value: unknown): value is string =>
  typeof value === "string" && UUID_V7_PATTERN.test(value);
