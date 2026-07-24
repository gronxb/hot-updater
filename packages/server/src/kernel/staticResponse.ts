import type { HotUpdaterPayloadTooLargeResponse } from "./contracts";
import { copyJsonValue } from "./jsonValue";

type CopyResult<T> =
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly value: T };

const invalid = Object.freeze({ kind: "invalid" }) satisfies CopyResult<never>;

const isPlainRecord = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const copyHeaders = (
  value: unknown,
): CopyResult<Readonly<Record<string, string>> | undefined> => {
  if (value === undefined) return { kind: "valid", value };
  if (!isPlainRecord(value)) return invalid;
  const output: Record<string, string> = {};
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return invalid;
    const stringKeys = keys.filter(
      (key): key is string => typeof key === "string",
    );
    stringKeys.sort((left, right) => left.localeCompare(right));
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      ) {
        return invalid;
      }
      new Headers([[key, descriptor.value]]);
      Object.defineProperty(output, key, {
        enumerable: true,
        value: descriptor.value,
      });
    }
  } catch {
    return invalid;
  }
  return { kind: "valid", value: Object.freeze(output) };
};

export const copyPayloadTooLargeResponse = (
  value: unknown,
): HotUpdaterPayloadTooLargeResponse | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    !Object.hasOwn(value, "body") ||
    !Object.hasOwn(value, "status") ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "body" && key !== "headers" && key !== "status"),
    )
  ) {
    return undefined;
  }
  const body = Object.getOwnPropertyDescriptor(value, "body");
  const headers = Object.getOwnPropertyDescriptor(value, "headers");
  const status = Object.getOwnPropertyDescriptor(value, "status");
  if (
    body === undefined ||
    !body.enumerable ||
    !("value" in body) ||
    (headers !== undefined && (!headers.enumerable || !("value" in headers))) ||
    status === undefined ||
    !status.enumerable ||
    !("value" in status) ||
    status.value !== 413
  ) {
    return undefined;
  }
  const copiedBody = copyJsonValue(body.value);
  const copiedHeaders = copyHeaders(
    headers !== undefined && "value" in headers ? headers.value : undefined,
  );
  if (copiedBody.kind === "invalid" || copiedHeaders.kind === "invalid") {
    return undefined;
  }
  return Object.freeze({
    body: copiedBody.value,
    headers: copiedHeaders.value,
    status: 413,
  });
};

export const payloadTooLargeResponse = (
  configured?: HotUpdaterPayloadTooLargeResponse,
): Response =>
  configured === undefined
    ? Response.json({ error: "Payload too large" }, { status: 413 })
    : Response.json(configured.body, {
        headers: configured.headers,
        status: configured.status,
      });
