import type {
  DatabaseAdapter,
  PhysicalTable,
  StoredRow,
} from "@hot-updater/plugin-core/internal";

/** The settings rows migrations write, last, and the fence reads. */
export const SETTINGS_TABLE: PhysicalTable = {
  name: "private_hot_updater_settings",
  columns: [
    { name: "key", type: "string", nullable: false, maxLength: 255 },
    { name: "value", type: "string", nullable: false, maxLength: 255 },
    { name: "_v", type: "integer", nullable: false, default: 0 },
  ],
  key: ["key"],
  indexes: [],
};

/** The engine's storage-layout generation; it changes only with a migration. */
export const ENGINE_SCHEMA_KEY = "schema.engine";
export const ENGINE_SCHEMA_VERSION = "1";

/** A schema setting the fence found missing or different. */
export interface SchemaSettingMismatch {
  readonly key: string;
  readonly expected: string;
  readonly found: string | null;
}

const settingMessage = (
  adapterName: string,
  { key, expected, found }: SchemaSettingMismatch,
) =>
  `Hot Updater schema setting "${key}" for ${adapterName} is ${found === null ? "missing" : `"${found}"`}; expected "${expected}". ${
    key === ENGINE_SCHEMA_KEY
      ? "Create a new empty database and run `hot-updater db migrate`; databases from before the storage engine are not converted."
      : "Run `hot-updater db migrate`."
  }`;

/** The database needs `hot-updater db migrate`, or a new database; the handler answers 503. */
export class HotUpdaterSchemaMigrationRequiredError extends Error {
  constructor(
    readonly adapterName: string,
    readonly currentVersion: string | undefined,
    readonly setting?: SchemaSettingMismatch,
    options?: ErrorOptions,
  ) {
    super(
      setting !== undefined
        ? settingMessage(adapterName, setting)
        : currentVersion === undefined
          ? `Hot Updater database schema is not initialized for ${adapterName}. Run \`hot-updater db migrate\` before using this adapter.`
          : `Hot Updater v1 cannot migrate schema ${currentVersion} in place. Create a new empty database and run \`hot-updater db migrate\`.`,
      options,
    );
    this.name = "HotUpdaterSchemaMigrationRequiredError";
  }
}

/** Settings keys and the values a process expects, `schema.engine` included. */
export type SchemaSettings = Readonly<Record<string, string>>;

/** Driver codes for a table or column the database lacks. */
const MISSING_SCHEMA_CODES = new Set([
  "42P01", // PostgreSQL undefined_table
  "42703", // PostgreSQL undefined_column
  "ER_NO_SUCH_TABLE", // MySQL 1146
  "ER_BAD_FIELD_ERROR", // MySQL 1054
]);
const MISSING_SCHEMA_MESSAGE =
  /no such (?:table|column)|(?:relation|column) .+ does not exist|table .+ doesn't exist|unknown column/iu;

/**
 * Whether a read failed because a table or column is missing, so the
 * database needs migrations. ORMs may wrap the driver's error in `cause`.
 */
export const isMissingSchemaError = (error: unknown): boolean => {
  for (let depth = 0; error instanceof Object && depth < 8; depth += 1) {
    const { code, message, cause } = error as Record<string, unknown>;
    if (
      MISSING_SCHEMA_CODES.has(String(code)) ||
      (typeof message === "string" && MISSING_SCHEMA_MESSAGE.test(message))
    ) {
      return true;
    }
    error = cause;
  }
  return false;
};

export const readSettings = async (
  adapter: DatabaseAdapter,
  keys: readonly string[],
): Promise<readonly (StoredRow | null)[]> =>
  adapter.get(
    SETTINGS_TABLE,
    keys.map((key) => [key]),
  );

/** Throws unless every expected setting is stored with its value: one batch read. */
export const checkSchemaFence = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  expected: SchemaSettings,
): Promise<void> => {
  const keys = Object.keys(expected);
  let rows: readonly (StoredRow | null)[];
  try {
    rows = await readSettings(adapter, keys);
  } catch (cause) {
    // A connection or driver failure is not a schema to migrate.
    if (!isMissingSchemaError(cause)) throw cause;
    throw new HotUpdaterSchemaMigrationRequiredError(
      adapterName,
      undefined,
      { key: ENGINE_SCHEMA_KEY, expected: ENGINE_SCHEMA_VERSION, found: null },
      { cause },
    );
  }
  keys.forEach((key, position) => {
    const found = rows[position]?.value;
    if (found !== expected[key]) {
      throw new HotUpdaterSchemaMigrationRequiredError(adapterName, undefined, {
        key,
        expected: expected[key]!,
        found: typeof found === "string" ? found : null,
      });
    }
  });
};

/**
 * The adapter behind the schema fence: a process's first read or write
 * checks the settings first. Success is kept; a failure is checked again on
 * the next call.
 */
export const withSchemaFence = (
  adapter: DatabaseAdapter,
  adapterName: string,
  expected: SchemaSettings,
): DatabaseAdapter => {
  let ready: Promise<void> | undefined;
  const fence = () => {
    ready ??= checkSchemaFence(adapter, adapterName, expected).catch(
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    return ready;
  };
  return {
    ...adapter,
    get: async (table, keys) => {
      await fence();
      return adapter.get(table, keys);
    },
    query: async (table, request) => {
      await fence();
      return adapter.query(table, request);
    },
    write: async (ops) => {
      await fence();
      return adapter.write(ops);
    },
  };
};
