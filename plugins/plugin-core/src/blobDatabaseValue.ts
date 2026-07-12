import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";

export const blobProperty = (value: object, key: string): unknown =>
  Reflect.get(value, key);

export const blobRecord = (value: unknown, source: string): object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BlobDatabaseSnapshotError(source);
  }
  return value;
};

export const blobArray = (
  value: unknown,
  source: string,
): readonly unknown[] => {
  if (!Array.isArray(value)) throw new BlobDatabaseSnapshotError(source);
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
