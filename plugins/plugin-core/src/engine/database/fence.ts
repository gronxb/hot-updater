import type {
  DatabaseAdapter,
  PhysicalTable,
  StoredRow,
} from "../../database/adapter";

/**
 * The settings rows migrations write, last, and the fence reads; retention
 * passes keep their lease here too. Tooling that creates the tables creates
 * this one with them: an ORM's schema generator, a provider's setup, and an
 * access policy that names the tables a server reads.
 */
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

const CORE_SCHEMA_KEY = "schema.core";

const stored = ({ key, expected, found }: SchemaSettingMismatch) =>
  `"${key}" is ${found === null ? "missing" : `"${found}"`}; expected "${expected}"`;

const settingMessage = (
  adapterName: string,
  { key, expected, found }: SchemaSettingMismatch,
) =>
  `Hot Updater schema setting "${key}" for ${adapterName} is ${found === null ? "missing" : `"${found}"`}; expected "${expected}". ${
    key === ENGINE_SCHEMA_KEY
      ? "Create a new empty database and run `hot-updater db migrate`; databases from before the storage engine are not converted."
      : "Run `hot-updater db migrate`."
  }`;

/** The plugin a `schema.<id>` setting belongs to; undefined for core's and the engine's. */
const pluginOf = ({ key }: SchemaSettingMismatch) =>
  key.startsWith("schema.") &&
  key !== ENGINE_SCHEMA_KEY &&
  key !== CORE_SCHEMA_KEY
    ? key.slice("schema.".length)
    : undefined;

const listed = (items: readonly string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** How to create plugins' tables when the fence was given no fix. */
const PLUGIN_TABLES_FIX =
  "Run `hot-updater db migrate`; on a managed server, rerun `hot-updater init` for its provider, which deploys the server with these plugins and creates their tables.";

const pluginsMessage = (
  adapterName: string,
  plugins: readonly string[],
  settings: readonly SchemaSettingMismatch[],
  fix: string,
) =>
  `The tables of ${plugins.length === 1 ? "plugin" : "plugins"} ${listed(plugins.map((id) => `"${id}"`))} are not migrated on ${adapterName}: schema ${settings.length === 1 ? "setting" : "settings"} ${settings.map(stored).join(", and ")}. ${fix}`;

/** The database needs `hot-updater db migrate`, or a new database; the handler answers 503. */
export class HotUpdaterSchemaMigrationRequiredError extends Error {
  /** Every setting the fence found missing or different; `setting` is the first. */
  readonly settings: readonly SchemaSettingMismatch[];
  /**
   * The ids of the plugins whose `schema.<id>` setting is among them: the
   * plugins whose tables a migration has yet to create or change.
   */
  readonly plugins: readonly string[];

  constructor(
    readonly adapterName: string,
    readonly currentVersion: string | undefined,
    readonly setting?: SchemaSettingMismatch,
    options?: ErrorOptions & {
      /** Every mismatch, when the fence found more than `setting`. */
      readonly settings?: readonly SchemaSettingMismatch[];
      /** How to create the plugins' tables on this database. */
      readonly fix?: string;
    },
  ) {
    const settings =
      options?.settings ?? (setting === undefined ? [] : [setting]);
    const plugins = settings.flatMap((mismatch) => pluginOf(mismatch) ?? []);
    super(
      setting === undefined
        ? currentVersion === undefined
          ? `Hot Updater database schema is not initialized for ${adapterName}. Run \`hot-updater db migrate\` before using this adapter.`
          : `Hot Updater v1 cannot migrate schema ${currentVersion} in place. Create a new empty database and run \`hot-updater db migrate\`.`
        : plugins.length > 0 && plugins.length === settings.length
          ? pluginsMessage(
              adapterName,
              plugins,
              settings,
              options?.fix ?? PLUGIN_TABLES_FIX,
            )
          : settingMessage(adapterName, setting),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "HotUpdaterSchemaMigrationRequiredError";
    this.settings = settings;
    this.plugins = plugins;
  }
}

/**
 * Settings keys and the values a process expects, `schema.engine` included:
 * a `ToolingTarget`'s settings.
 */
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

export const readSettings = (
  adapter: DatabaseAdapter,
  keys: readonly string[],
) =>
  adapter.get(
    SETTINGS_TABLE,
    keys.map((key) => [key]),
  );

/**
 * Throws unless every expected setting is stored with its value: one batch
 * read. The error lists every setting missing or different; `fix` says how
 * to create the plugins' tables on this database.
 */
export const checkSchemaFence = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  expected: SchemaSettings,
  fix?: string,
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
  const settings = keys.flatMap((key, position) => {
    const found = rows[position]?.value;
    return found === expected[key]
      ? []
      : [
          {
            key,
            expected: expected[key]!,
            found: typeof found === "string" ? found : null,
          },
        ];
  });
  const [first] = settings;
  if (first !== undefined) {
    throw new HotUpdaterSchemaMigrationRequiredError(
      adapterName,
      undefined,
      first,
      { settings, ...(fix === undefined ? {} : { fix }) },
    );
  }
};

/** The database name a fenced adapter carries, so a server can fence its plugins' rows too. */
const FENCED: unique symbol = Symbol.for("@hot-updater/server/schema-fence");

interface FencedAdapter extends DatabaseAdapter {
  readonly [FENCED]?: string;
}

/** The database name an adapter behind the schema fence reports under. */
export const fencedName = (adapter: FencedAdapter): string | undefined =>
  adapter[FENCED];

/**
 * The adapter behind the schema fence: a process's first read or write
 * checks the settings first. Success is kept; a failure is checked again on
 * the next call.
 */
export const withSchemaFence = (
  adapter: DatabaseAdapter,
  adapterName: string,
  expected: SchemaSettings,
  fix?: string,
): FencedAdapter => {
  let ready: Promise<void> | undefined;
  const fence = () => {
    ready ??= checkSchemaFence(adapter, adapterName, expected, fix).catch(
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    return ready;
  };
  return {
    ...adapter,
    [FENCED]: adapterName,
    get: (table, keys) => fence().then(() => adapter.get(table, keys)),
    query: (table, request) =>
      fence().then(() => adapter.query(table, request)),
    write: (ops) => fence().then(() => adapter.write(ops)),
    ...(adapter.prune && {
      prune: (table, before, limit) =>
        fence().then(() => adapter.prune!(table, before, limit)),
    }),
  };
};
