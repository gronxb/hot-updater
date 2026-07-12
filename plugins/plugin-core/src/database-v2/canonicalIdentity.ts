import {
  addWeakSetValueV2,
  createWeakSetV2,
  deleteWeakSetValueV2,
  hasWeakSetValueV2,
} from "./collectionIntrinsics";
import { DatabaseConnectorErrorV2 } from "./errors";

const failCanonicalization = (message: string): never => {
  throw new DatabaseConnectorErrorV2("CANONICALIZATION_FAILED", message);
};

const validateUnicodeScalars = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        failCanonicalization("string contains an unpaired high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      failCanonicalization("string contains an unpaired low surrogate");
    }
  }
};

const serializeJsonToken = (value: string | number): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return failCanonicalization("value has no JSON token");
  }
  return serialized;
};

const isAccessor = (descriptor: PropertyDescriptor): boolean =>
  Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set");

const validateDataDescriptor = (
  descriptor: PropertyDescriptor,
  label: string,
): void => {
  if (!descriptor.enumerable) {
    failCanonicalization(`${label} must be enumerable`);
  }
  if (isAccessor(descriptor)) {
    failCanonicalization(`${label} must be a data property`);
  }
};

const serializeArray = (
  value: readonly unknown[],
  ancestors: WeakSet<object>,
): string => {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return failCanonicalization("array has a non-plain prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length > 0) {
    return failCanonicalization("array has an own symbol key");
  }
  const entries = Object.entries(descriptors);
  const names = entries.map(([name]) => name);
  const lengthDescriptor: PropertyDescriptor | undefined = entries.find(
    ([name]) => name === "length",
  )?.[1];
  if (
    lengthDescriptor === undefined ||
    isAccessor(lengthDescriptor) ||
    lengthDescriptor.enumerable
  ) {
    return failCanonicalization("array is sparse or has extra properties");
  }
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    names.length !== length + 1
  ) {
    return failCanonicalization("array is sparse or has extra properties");
  }
  const itemDescriptors: PropertyDescriptor[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) {
      return failCanonicalization("array is sparse");
    }
    validateDataDescriptor(descriptor, `array index ${index}`);
    itemDescriptors.push(descriptor);
  }
  return `[${itemDescriptors
    .map((descriptor) => serializeValue(descriptor.value, ancestors))
    .join(",")}]`;
};

const serializeObject = (value: object, ancestors: WeakSet<object>): string => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return failCanonicalization("object has a non-plain prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length > 0) {
    return failCanonicalization("object has an own symbol key");
  }
  const entries = Object.entries(descriptors);
  for (const [key, descriptor] of entries) {
    validateUnicodeScalars(key);
    validateDataDescriptor(descriptor, `object property ${key}`);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(
      ([key, descriptor]) =>
        `${serializeJsonToken(key)}:${serializeValue(descriptor.value, ancestors)}`,
    )
    .join(",")}}`;
};

const serializeValue = (value: unknown, ancestors: WeakSet<object>): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    validateUnicodeScalars(value);
    return serializeJsonToken(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return failCanonicalization("number must be finite and must not be -0");
    }
    return serializeJsonToken(value);
  }
  if (typeof value !== "object") {
    return failCanonicalization(`unsupported value type: ${typeof value}`);
  }
  if (hasWeakSetValueV2(ancestors, value)) {
    return failCanonicalization("value contains a cycle");
  }
  addWeakSetValueV2(ancestors, value);
  const serialized = Array.isArray(value)
    ? serializeArray(value, ancestors)
    : serializeObject(value, ancestors);
  deleteWeakSetValueV2(ancestors, value);
  return serialized;
};

export const canonicalizeDatabaseValueV1 = (value: unknown): string => {
  try {
    return serializeValue(value, createWeakSetV2<object>());
  } catch (error) {
    if (error instanceof DatabaseConnectorErrorV2) {
      throw error;
    }
    throw new DatabaseConnectorErrorV2(
      "CANONICALIZATION_FAILED",
      "value could not be inspected safely",
      { cause: error },
    );
  }
};

export const snapshotCanonicalDatabaseValueV1 = <T>(value: T): T =>
  JSON.parse(canonicalizeDatabaseValueV1(value));
