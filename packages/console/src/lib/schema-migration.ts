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
  /**
   * Whether `hot-updater doctor --fix` migrates it: every setting is missing
   * or older. False for a database a newer release migrated, a different
   * storage layout, or a v0 database, which doctor reports and never moves.
   */
  readonly migratable: boolean;
}

/** Compares dotted numeric versions, such as "1" and "1.2.0"; NaN when either is not one. */
const compareVersions = (left: string, right: string): number => {
  const parse = (version: string) => version.split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  if ([...a, ...b].some(Number.isNaN)) return Number.NaN;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** Whether a setting is one a migration moves forward. */
const migrates = ({ key, expected, found }: SchemaSetting) =>
  found === null ||
  (key !== "schema.engine" && compareVersions(found, expected) < 0);

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
  const {
    settings = [],
    plugins = [],
    currentVersion,
  } = error as Error & {
    readonly settings?: readonly SchemaSetting[];
    readonly plugins?: readonly string[];
    /** A v0 database's schema version. */
    readonly currentVersion?: string;
  };
  return {
    message: error.message,
    settings: settings.map(({ key, expected, found }) => ({
      key,
      expected,
      found,
    })),
    plugins: [...plugins],
    migratable:
      currentVersion === undefined &&
      settings.length > 0 &&
      settings.every(migrates),
  };
};
