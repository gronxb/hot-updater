export class FirebaseDatabaseDataError extends Error {
  readonly name = "FirebaseDatabaseDataError";

  constructor(readonly source: string) {
    super(`Invalid Firebase database data at "${source}".`);
  }
}

export const record = (value: unknown, source: string): object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FirebaseDatabaseDataError(source);
  }
  return value;
};

export const property = (value: object, key: string): unknown =>
  Reflect.get(value, key);

export const hasFirebaseProperty = (value: unknown, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  key in value;

export const string = (value: unknown, source: string): string => {
  if (typeof value !== "string") throw new FirebaseDatabaseDataError(source);
  return value;
};

export const nullableString = (
  value: unknown,
  source: string,
): string | null => {
  if (value === null || value === undefined) return null;
  return string(value, source);
};

export const boolean = (value: unknown, source: string): boolean => {
  if (typeof value !== "boolean") throw new FirebaseDatabaseDataError(source);
  return value;
};

export const number = (value: unknown, source: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FirebaseDatabaseDataError(source);
  }
  return value;
};

export const stringArray = (
  value: unknown,
  source: string,
): readonly string[] | null => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new FirebaseDatabaseDataError(source);
  return value.map((item) => string(item, source));
};

export const platform = (value: unknown, source: string): "android" | "ios" => {
  if (value === "android" || value === "ios") return value;
  throw new FirebaseDatabaseDataError(source);
};
