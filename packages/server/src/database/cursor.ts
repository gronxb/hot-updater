import type { DatabaseKey } from "@hot-updater/plugin-core/internal";

export class DatabaseCursorError extends Error {
  readonly name = "DatabaseCursorError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (text: string): string => {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const fromBase64Url = (value: string): string => {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

/** FNV-1a over the request's identity; a cursor only resumes the same read. */
export const cursorScope = (parts: readonly unknown[]): string => {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(JSON.stringify(parts))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

export const encodeCursor = (scope: string, after: DatabaseKey): string =>
  toBase64Url(JSON.stringify([scope, after]));

/** The order tuple a cursor resumes after; rejects a cursor from another read. */
export const decodeCursor = (scope: string, cursor: string): DatabaseKey => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new DatabaseCursorError("The cursor is malformed.");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    !Array.isArray(decoded[1]) ||
    !decoded[1].every(
      (value: unknown) =>
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
    )
  ) {
    throw new DatabaseCursorError("The cursor is malformed.");
  }
  if (decoded[0] !== scope) {
    throw new DatabaseCursorError(
      "The cursor belongs to a read with another model, index, filter, order, or range.",
    );
  }
  return decoded[1] as DatabaseKey;
};
