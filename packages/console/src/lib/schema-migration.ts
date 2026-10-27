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
   * Whether a migration moves it forward: every setting is missing or older.
   * False for a database a newer release migrated, a different storage
   * layout, or a v0 database, which doctor reports and nothing moves.
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

/** The brand Hot Updater's own plugin factories set, read as the server reads it. */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

/**
 * Whether a migration moves a setting forward: a missing one, or an older
 * version of core's or of one of Hot Updater's own plugins. Another plugin's
 * changed tables need its own migration.
 */
const migrates = (
  { key, expected, found }: SchemaSetting,
  official: ReadonlySet<string>,
) =>
  found === null ||
  ((key === "schema.core" || official.has(key)) &&
    compareVersions(found, expected) < 0);

/**
 * The fence's refusal in `error`, recognized by name: plugin-core may be
 * another copy than the console's. Null for any other error.
 */
export const schemaMigrationOf = (
  error: unknown,
  /** The plugins the console's config lists. */
  plugins: readonly unknown[] = [],
): SchemaMigrationStatus | null => {
  if (
    !(error instanceof Error) ||
    error.name !== "HotUpdaterSchemaMigrationRequiredError"
  ) {
    return null;
  }
  const official = new Set(
    plugins.flatMap((plugin) =>
      typeof plugin === "object" &&
      plugin !== null &&
      Reflect.get(plugin, OFFICIAL) === true
        ? [`schema.${String(Reflect.get(plugin, "id"))}`]
        : [],
    ),
  );
  const {
    settings = [],
    plugins: refused = [],
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
    plugins: [...refused],
    migratable:
      currentVersion === undefined &&
      settings.length > 0 &&
      settings.every((setting) => migrates(setting, official)),
  };
};
