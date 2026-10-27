import { createMigrator } from "@hot-updater/cli-tools";
import { isRemoteDatabase } from "@hot-updater/plugin-core";

import type { LoadedServer } from "../../utils/loadServer";
import type { DoctorContext } from "./context";
import type { SchemaIssue, SchemaSetting, SchemaStatus } from "./issues";
import type { ManagedDeployment } from "./managed";

/** The fence's error, by name: it may come from another copy of plugin-core. */
interface SchemaMigrationRequired {
  readonly name: "HotUpdaterSchemaMigrationRequiredError";
  readonly message: string;
  readonly settings: readonly SchemaSetting[];
  /** A v0 database's schema version. */
  readonly currentVersion?: string;
}

const isSchemaMigrationRequired = (
  error: unknown,
): error is SchemaMigrationRequired =>
  error instanceof Error &&
  error.name === "HotUpdaterSchemaMigrationRequiredError" &&
  Array.isArray((error as { settings?: unknown }).settings);

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

const describeSetting = ({ key, expected, found }: SchemaSetting) =>
  `${key} is ${found === null ? "missing" : `"${found}"`}, expected "${expected}"`;

const listed = (settings: readonly SchemaSetting[]) =>
  settings.map(describeSetting).join("; ");

/** The brand Hot Updater's own plugin factories set, read as the server reads it. */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

/**
 * The settings whose versions Hot Updater orders and changes only with a
 * migration of its own: the engine's, core's, and its own plugins'.
 */
const ownedSettingKeys = ({ plugins }: LoadedServer): ReadonlySet<string> =>
  new Set([
    "schema.engine",
    "schema.core",
    ...plugins.flatMap((plugin) =>
      Reflect.get(plugin, OFFICIAL) === true ? [`schema.${plugin.id}`] : [],
    ),
  ]);

/** That a server must change with the migration, and why they run back to back. */
const SERVER_ORDER =
  "A server of an earlier release answers 503 once the database is migrated, and a server of this release answers 503 until it is";

const DB_MIGRATE = "npx hot-updater db migrate <server file>";
const DB_GENERATE = "npx hot-updater db generate <server file>";

/**
 * What migrates the database, and the commands that do: init again for a
 * deployment init manages, which migrates and redeploys its server back to
 * back; otherwise the database's own tooling in the server's project.
 */
const pendingResolution = (
  { database }: LoadedServer,
  managed: ManagedDeployment | null,
): { readonly resolution: string; readonly commands: string[] } => {
  if (managed !== null) {
    return {
      resolution: `Run \`${managed.command}\`: it applies the migrations this release needs, then redeploys ${managed.server} from it, back to back. ${SERVER_ORDER}, so run nothing in between.`,
      commands: [managed.command],
    };
  }
  const tooling = database as typeof database & {
    readonly createMigrator?: unknown;
    readonly generateSchema?: unknown;
  };
  const order = `${SERVER_ORDER}: migrate it as you deploy the server of this release.`;
  if (tooling.generateSchema !== undefined) {
    // Drizzle, Prisma, D1 and Supabase own their table definitions: a
    // migrator would only write the settings rows over missing tables.
    return tooling.createMigrator === undefined
      ? {
          resolution: `In the server's project, run \`${DB_GENERATE}\` and apply the migration it writes with the database's tooling. ${order}`,
          commands: [DB_GENERATE],
        }
      : {
          resolution: `In the server's project, run \`${DB_GENERATE}\`, apply the migration it writes with the database's tooling, such as your ORM or \`wrangler d1 migrations apply\`, then run \`${DB_MIGRATE}\` to write the settings rows. ${order}`,
          commands: [DB_GENERATE, DB_MIGRATE],
        };
  }
  if (tooling.createMigrator !== undefined) {
    return {
      resolution: `In the server's project, run \`${DB_MIGRATE}\`: it creates the missing tables and writes the settings rows. ${order}`,
      commands: [DB_MIGRATE],
    };
  }
  return {
    resolution: `In the server's project, run \`npx hot-updater db generate --sql\` and apply the file it writes with the database's tooling. ${order}`,
    commands: ["npx hot-updater db generate --sql"],
  };
};

/**
 * The schema the server's fence checks, against what this CLI's core and the
 * plugins in hot-updater.config.ts expect: one read through the server, which
 * passes the fence or fails it with every setting it found missing or
 * different, core's and the plugins' together. Undefined when the fence
 * passes, or the read failed for another reason, which the server data checks
 * report.
 */
export const checkSchema = async (
  context: DoctorContext,
): Promise<SchemaStatus | undefined> => {
  let server: LoadedServer | null;
  try {
    server = await context.server();
  } catch {
    return undefined;
  }
  // A self-hosted server's admin API checks its own fence.
  if (server === null || isRemoteDatabase(server.database)) return undefined;
  try {
    await server.core.listChannels();
    return undefined;
  } catch (error) {
    if (!isSchemaMigrationRequired(error)) return undefined;
    return schemaStatus(
      server,
      error,
      await v0VersionOf(server, error),
      await context.managed(),
    );
  }
};

/**
 * A v0 database's schema version: the fence finds neither `schema.engine`
 * nor `schema.core` on one, so the migrator reads the `version` row it kept.
 * One read, only when both are missing; undefined on any other database.
 */
const v0VersionOf = async (
  { database, plugins }: LoadedServer,
  { settings }: SchemaMigrationRequired,
): Promise<string | undefined> => {
  const missing = (key: string) =>
    settings.some((setting) => setting.key === key && setting.found === null);
  const tooling = database as typeof database & {
    readonly createMigrator?: unknown;
  };
  if (
    isRemoteDatabase(database) ||
    tooling.createMigrator === undefined ||
    !missing("schema.engine") ||
    !missing("schema.core")
  ) {
    return undefined;
  }
  return createMigrator({ database, plugins })
    .getVersion()
    .catch(() => undefined);
};

const schemaStatus = (
  server: LoadedServer,
  { message, settings, currentVersion: fenced }: SchemaMigrationRequired,
  v0Version: string | undefined,
  managed: ManagedDeployment | null,
): SchemaStatus => {
  const currentVersion = fenced ?? v0Version;
  const issues: SchemaIssue[] = [];
  if (currentVersion !== undefined || settings.length === 0) {
    // A v0 database, or one the fence could not describe.
    issues.push({
      type: "error",
      code: "SCHEMA_NOT_MIGRATABLE",
      message:
        currentVersion === undefined
          ? message
          : `The database is a Hot Updater v0 database, schema ${currentVersion}.`,
      resolution:
        "Create a new empty database and point hot-updater.config.ts at it; Hot Updater v1 does not migrate a v0 database in place.",
    });
    return { settings: [...settings], issues };
  }
  const owned = ownedSettingKeys(server);
  // The engine's layout, or a version of Hot Updater's own this CLI cannot
  // compare, is never migrated in place.
  const engine = settings.filter(
    ({ key, expected, found }) =>
      found !== null &&
      (key === "schema.engine" ||
        (owned.has(key) && Number.isNaN(compareVersions(found, expected)))),
  );
  const newer = settings.filter(
    (setting) =>
      !engine.includes(setting) &&
      owned.has(setting.key) &&
      setting.found !== null &&
      compareVersions(setting.found, setting.expected) > 0,
  );
  // Another plugin's version differs: its own migration changes its
  // tables, which a migration here, creating only what is missing, skips.
  const changed = settings.filter(
    (setting) =>
      !engine.includes(setting) &&
      !newer.includes(setting) &&
      setting.found !== null &&
      !owned.has(setting.key),
  );
  const pending = settings.filter(
    (setting) =>
      !engine.includes(setting) &&
      !newer.includes(setting) &&
      !changed.includes(setting),
  );
  if (engine.length > 0) {
    issues.push({
      type: "error",
      code: "SCHEMA_NOT_MIGRATABLE",
      message: `The database's schema settings are not ones this hot-updater migrates: ${listed(engine)}.`,
      resolution:
        "Use the hot-updater version the database was created with, or create a new empty database.",
    });
  }
  if (newer.length > 0) {
    issues.push({
      type: "error",
      code: "SCHEMA_NEWER_THAN_CLI",
      message: `The database was migrated by a newer hot-updater: ${listed(newer)}.`,
      resolution:
        "Upgrade hot-updater and the @hot-updater packages to the version that migrated the database. Hot Updater never moves a schema back.",
    });
  }
  if (changed.length > 0) {
    issues.push({
      type: "error",
      code: "PLUGIN_SCHEMA_CHANGED",
      message: `A plugin's version differs from the one the database recorded: ${listed(changed)}.`,
      resolution:
        "Apply the plugin's own migration for its changed tables, or use the plugin version that migrated the database; then run `npx hot-updater db migrate` in the server's project to record its version. Hot Updater's migrations create missing tables and change no existing one.",
    });
  }
  // A migration writes every setting, so it would move a blocked one back,
  // or record a changed plugin before its own migration ran.
  if (
    pending.length > 0 &&
    engine.length === 0 &&
    newer.length === 0 &&
    changed.length === 0
  ) {
    issues.push({
      type: "error",
      code: "SCHEMA_MIGRATION_PENDING",
      message: `The database has migrations to run before the server reads it: ${listed(pending)}.`,
      ...pendingResolution(server, managed),
      settings: pending,
    });
  }
  return { settings: [...settings], issues };
};
