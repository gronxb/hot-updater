export const AWS_DATABASE_TYPES = ["dynamodb", "s3"] as const;

export type AwsDatabaseType = (typeof AWS_DATABASE_TYPES)[number];

export const isAwsDatabaseType = (
  value: string | undefined,
): value is AwsDatabaseType =>
  value !== undefined && AWS_DATABASE_TYPES.some((type) => type === value);
