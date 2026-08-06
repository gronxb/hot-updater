import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import { isDatabaseMetadataObject } from "./databaseJsonValue";
import type { DatabaseBundleMetadata } from "./types";

const recordSources = new WeakMap<object, string>();

export const blobProperty = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && "value" in descriptor) return descriptor.value;
  if (descriptor || key in value) {
    throw new BlobDatabaseSnapshotError(recordSources.get(value) ?? key);
  }
  return undefined;
};

export const blobRecord = (value: unknown, source: string): object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BlobDatabaseSnapshotError(source);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BlobDatabaseSnapshotError(source);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__") {
      throw new BlobDatabaseSnapshotError(source);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new BlobDatabaseSnapshotError(source);
    }
  }
  recordSources.set(value, source);
  return value;
};

export const blobArray = (
  value: unknown,
  source: string,
): readonly unknown[] => {
  if (!Array.isArray(value)) throw new BlobDatabaseSnapshotError(source);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new BlobDatabaseSnapshotError(source);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    throw new BlobDatabaseSnapshotError(source);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new BlobDatabaseSnapshotError(source);
    }
  }
  return value;
};

export const blobMetadataObject = (
  value: unknown,
  source: string,
): DatabaseBundleMetadata => {
  if (!isDatabaseMetadataObject(value)) {
    throw new BlobDatabaseSnapshotError(source);
  }
  return value;
};

export const blobString = (value: unknown, source: string): string => {
  if (typeof value !== "string") throw new BlobDatabaseSnapshotError(source);
  return value;
};

export const blobBoolean = (value: unknown, source: string): boolean => {
  if (typeof value !== "boolean") throw new BlobDatabaseSnapshotError(source);
  return value;
};

export const blobNumber = (value: unknown, source: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BlobDatabaseSnapshotError(source);
  }
  return value;
};

export const blobNullableString = (
  value: unknown,
  source: string,
): string | null => {
  if (value === null || value === undefined) return null;
  return blobString(value, source);
};

export const blobStringArray = (
  value: unknown,
  source: string,
): readonly string[] | null => {
  if (value === null || value === undefined) return null;
  return blobArray(value, source).map((item) => blobString(item, source));
};

export const blobPlatform = (
  value: unknown,
  source: string,
): "android" | "ios" => {
  if (value === "android" || value === "ios") return value;
  throw new BlobDatabaseSnapshotError(source);
};
