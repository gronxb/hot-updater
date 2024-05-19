export const isNullable = (value: unknown): value is null | undefined =>
  value === null || value === undefined;
