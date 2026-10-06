import { getUtf8ByteLength } from "@hot-updater/protocol";

/** Bound the JSON wire size without rewriting the error text or splitting Unicode. */
export const boundedText = (text: string, maxBytes: number): string => {
  if (getUtf8ByteLength(JSON.stringify(text)) <= maxBytes) return text;
  let result = "";
  let bytes = 2 + getUtf8ByteLength("…");
  for (const character of text) {
    bytes += getUtf8ByteLength(JSON.stringify(character)) - 2;
    if (bytes > maxBytes) break;
    result += character;
  }
  return `${result}…`;
};

/** Error properties are not enumerable, so JSON.stringify(error) would lose them. */
export const readErrorDetails = (
  error: unknown,
): {
  errorMessage?: string;
  errorStack?: string;
} => {
  if (error == null) return {};
  const object = typeof error === "object" ? error : null;
  let message: string;
  if (object && "message" in object && typeof object.message === "string") {
    message = object.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  const stack =
    object && "stack" in object && typeof object.stack === "string"
      ? object.stack
      : undefined;
  return {
    ...(message ? { errorMessage: boundedText(message, 2_048) } : {}),
    ...(stack ? { errorStack: boundedText(stack, 4_096) } : {}),
  };
};
