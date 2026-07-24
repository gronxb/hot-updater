import type { JsonValue } from "./contracts";

export type JsonValueCopyResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly value: JsonValue };

const invalid = Object.freeze({
  kind: "invalid",
}) satisfies JsonValueCopyResult;

const copyArray = (
  value: readonly unknown[],
  ancestors: WeakSet<object>,
): JsonValueCopyResult => {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9]\d*)$/u.test(key)),
    )
  ) {
    return invalid;
  }
  const output: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return invalid;
    }
    const copied = copyJson(descriptor.value, ancestors);
    if (copied.kind === "invalid") return invalid;
    output.push(copied.value);
  }
  return { kind: "valid", value: Object.freeze(output) };
};

const copyObject = (
  value: object,
  ancestors: WeakSet<object>,
): JsonValueCopyResult => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return invalid;
  const keys = ownKeys.filter((key): key is string => typeof key === "string");
  keys.sort((left, right) => left.localeCompare(right));
  const output: Record<string, JsonValue> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return invalid;
    }
    const copied = copyJson(descriptor.value, ancestors);
    if (copied.kind === "invalid") return invalid;
    Object.defineProperty(output, key, {
      enumerable: true,
      value: copied.value,
    });
  }
  return { kind: "valid", value: Object.freeze(output) };
};

const copyJson = (
  value: unknown,
  ancestors: WeakSet<object>,
): JsonValueCopyResult => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return { kind: "valid", value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { kind: "valid", value } : invalid;
  }
  if (typeof value !== "object" || ancestors.has(value)) return invalid;

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? copyArray(value, ancestors)
      : copyObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
};

export const copyJsonValue = (value: unknown): JsonValueCopyResult =>
  copyJson(value, new WeakSet());

export const isJsonRecord = (
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
