/** The name of the schema fence's error, which survives serialization where its class does not. */
const SCHEMA_MIGRATION_REQUIRED = "HotUpdaterSchemaMigrationRequiredError";

/** A schema setting the fence found missing or different. */
export interface SchemaSetting {
  readonly key: string;
  readonly expected: string;
  readonly found: string | null;
}

/**
 * The database needs migrations before the console can read it: the fence's
 * error, as a server function sends it.
 */
export type SchemaMigrationRequiredError = Error & {
  readonly settings: readonly SchemaSetting[];
  /** The plugins whose tables a migration has yet to create or change. */
  readonly plugins: readonly string[];
};

export const isSchemaMigrationRequiredError = (
  error: unknown,
): error is SchemaMigrationRequiredError =>
  error instanceof Error &&
  error.name === SCHEMA_MIGRATION_REQUIRED &&
  Array.isArray(Reflect.get(error, "settings"));

/**
 * The fence's error without the driver error behind it, which may not
 * serialize, answered with 503 as the server's own handlers answer it. Any
 * other error is returned as it is.
 */
export const toPublicSchemaError = (error: unknown): unknown => {
  if (!isSchemaMigrationRequiredError(error)) return error;
  return Object.assign(new Error(error.message), {
    name: SCHEMA_MIGRATION_REQUIRED,
    settings: error.settings.map(({ key, expected, found }) => ({
      key,
      expected,
      found,
    })),
    plugins: [...error.plugins],
    status: 503,
  });
};
