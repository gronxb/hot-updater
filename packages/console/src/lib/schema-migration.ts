/** A schema setting the fence found missing or different. */
export interface SchemaSetting {
  readonly key: string;
  readonly expected: string;
  readonly found: string | null;
}

/**
 * The database needs migrations before the console can read it: what the
 * schema fence reported, as plain data. TanStack Start sends a thrown error
 * as its message alone, so the console asks for this separately.
 */
export interface SchemaMigrationStatus {
  readonly message: string;
  readonly settings: readonly SchemaSetting[];
  /** The plugins whose tables a migration has yet to create or change. */
  readonly plugins: readonly string[];
}

/**
 * The fence's refusal in `error`, recognized by name: plugin-core may be
 * another copy than the console's. Null for any other error.
 */
export const schemaMigrationOf = (
  error: unknown,
): SchemaMigrationStatus | null => {
  if (
    !(error instanceof Error) ||
    error.name !== "HotUpdaterSchemaMigrationRequiredError"
  ) {
    return null;
  }
  const { settings, plugins } = error as Error & {
    readonly settings?: readonly SchemaSetting[];
    readonly plugins?: readonly string[];
  };
  return {
    message: error.message,
    settings: (settings ?? []).map(({ key, expected, found }) => ({
      key,
      expected,
      found,
    })),
    plugins: [...(plugins ?? [])],
  };
};
