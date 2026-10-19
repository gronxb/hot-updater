import { createMigrator } from "@hot-updater/cli-tools";
import { isRemoteDatabase } from "@hot-updater/plugin-core";

import type { LoadedServer } from "../../utils/loadServer";
import { type InitProvider, INIT_PROVIDER_PACKAGES } from "../initProviders";
import type { DoctorContext } from "./context";
import type { SchemaIssue, SchemaSetting, SchemaStatus } from "./issues";

const DOCTOR_FIX = "npx hot-updater doctor --fix";

/**
 * The managed databases whose schema ships as numbered migration files, by
 * database name: the provider's `./init` applies the ones a database has not
 * run. Every other database migrates through its own migrator.
 */
const MIGRATION_FILE_PROVIDERS: Readonly<Record<string, InitProvider>> = {
  d1Database: "cloudflare",
  supabaseDatabase: "supabase",
};

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

/** How `--fix` migrates a database, by what its tooling offers. */
const migrationPath = (server: LoadedServer) => {
  const { database } = server;
  const tooling = database as typeof database & {
    readonly createMigrator?: unknown;
    readonly generateSchema?: unknown;
  };
  if (Object.hasOwn(MIGRATION_FILE_PROVIDERS, database.name)) {
    return "migration-files" as const;
  }
  if (tooling.createMigrator !== undefined) {
    // Drizzle and Prisma apply their own tables: their migrator only writes
    // the settings rows, which would pass the fence over missing tables.
    return tooling.generateSchema === undefined
      ? ("migrator" as const)
      : ("orm" as const);
  }
  return "schema-file" as const;
};

const pendingResolution = (server: LoadedServer) => {
  switch (migrationPath(server)) {
    case "migration-files":
      return `Run \`${DOCTOR_FIX}\` to apply the provider's migrations this database has not run. They create core's tables and the official plugins'.`;
    case "migrator":
      return `Run \`${DOCTOR_FIX}\` to create the missing tables and write the settings rows.`;
    case "orm":
      return "Run `npx hot-updater db generate`, apply the schema with your ORM, then run `npx hot-updater db migrate` in the server's project to write the settings rows.";
    case "schema-file":
      return "Run `npx hot-updater db generate` and apply the file it writes with the database's tooling.";
  }
};

/**
 * The schema the server's fence checks, against what this CLI's core and the
 * plugins in hot-updater.config.ts expect: one read through the server, which
 * passes the fence or fails it with every setting it found missing or
 * different. A fence that finds core's settings stale reports them before
 * the plugins'; `--fix` migrates both. Undefined when the fence passes, or the
 * read failed for another reason, which the server data checks report.
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
  if (server === null) return undefined;
  try {
    await server.core.listChannels();
    return undefined;
  } catch (error) {
    if (!isSchemaMigrationRequired(error)) return undefined;
    return schemaStatus(server, error);
  }
};

const schemaStatus = (
  server: LoadedServer,
  { message, settings, currentVersion }: SchemaMigrationRequired,
): SchemaStatus => {
  const issues: SchemaIssue[] = [];
  if (currentVersion !== undefined || settings.length === 0) {
    // A v0 database, or one the fence could not describe.
    issues.push({
      type: "error",
      code: "SCHEMA_NOT_MIGRATABLE",
      message,
      resolution:
        "Create a new empty database and point hot-updater.config.ts at it; Hot Updater v1 does not migrate a v0 database in place.",
      fixability: "blocked",
    });
    return { settings: [...settings], issues };
  }
  const engine = settings.filter(
    ({ key, found }) => key === "schema.engine" && found !== null,
  );
  const newer = settings.filter(
    ({ key, expected, found }) =>
      key !== "schema.engine" &&
      found !== null &&
      compareVersions(found, expected) > 0,
  );
  const pending = settings.filter(
    (setting) => !engine.includes(setting) && !newer.includes(setting),
  );
  if (engine.length > 0) {
    issues.push({
      type: "error",
      code: "SCHEMA_NOT_MIGRATABLE",
      message: `The database's storage layout differs from this hot-updater's: ${listed(engine)}.`,
      resolution:
        "Use the hot-updater version the database was created with, or create a new empty database.",
      fixability: "blocked",
    });
  }
  if (newer.length > 0) {
    issues.push({
      type: "error",
      code: "SCHEMA_NEWER_THAN_CLI",
      message: `The database was migrated by a newer hot-updater: ${listed(newer)}.`,
      resolution:
        "Upgrade hot-updater and the @hot-updater packages to the version that migrated the database. doctor --fix never moves a schema back.",
      fixability: "blocked",
    });
  }
  if (pending.length > 0) {
    issues.push({
      type: "error",
      code: "SCHEMA_MIGRATION_PENDING",
      message: `The database has migrations to run before the server reads it: ${listed(pending)}.`,
      resolution: pendingResolution(server),
      settings: pending,
      fixability: migrationPath(server) === "orm" ? "command" : "auto",
      commands:
        migrationPath(server) === "orm"
          ? ["npx hot-updater db generate", "npx hot-updater db migrate"]
          : [DOCTOR_FIX],
    });
  }
  return { settings: [...settings], issues };
};

/**
 * Migrates the server's database to what this CLI's core and the configured
 * plugins expect, as SCHEMA_MIGRATION_PENDING's repair: a managed D1 or
 * Supabase database runs the provider's migration files it has not run,
 * and any other database with a migrator creates the missing tables and
 * writes the settings rows, as `hot-updater db migrate` and the providers'
 * `migrate*` functions do. Returns what it applied, or why it did not.
 */
export const migrateServerSchema = async (
  context: DoctorContext,
  settings: readonly SchemaSetting[],
): Promise<{ wrote: string[] } | { skip: string }> => {
  const server = await context.server();
  if (server === null) throw new Error("hot-updater.config.ts names no database.");
  const { database, plugins } = server;
  if (isRemoteDatabase(database)) {
    return {
      skip: "The server migrates its own database. Run `npx hot-updater db migrate` in the server's project.",
    };
  }
  switch (migrationPath(server)) {
    case "migration-files": {
      const provider = MIGRATION_FILE_PROVIDERS[database.name]!;
      const { packageName, load } = INIT_PROVIDER_PACKAGES[provider];
      const { migrateDatabase } = await load();
      if (migrateDatabase === undefined) {
        return {
          skip: `${packageName} applies no migrations for this hot-updater; install the ${packageName} version that matches it.`,
        };
      }
      const result = await migrateDatabase({
        cwd: context.cwd,
        nonInteractive: !process.stdin.isTTY,
      });
      return "skip" in result
        ? { skip: result.skip }
        : { wrote: result.applied.map((name) => `migration ${name}`) };
    }
    case "migrator": {
      const migrator = createMigrator({ database, plugins });
      const migration = await migrator.migrateToLatest({ updateSettings: true });
      await migration.execute();
      return {
        wrote:
          migration.operations.length === 0
            ? []
            : settings.map(({ key, expected }) => `${key} ${expected}`),
      };
    }
    case "orm":
      return {
        skip: "Drizzle and Prisma create their own tables. Run `npx hot-updater db generate`, apply the schema with your ORM, then run `npx hot-updater db migrate` in the server's project.",
      };
    case "schema-file":
      return {
        skip: "This database applies its schema from a file. Run `npx hot-updater db generate` and apply the file it writes.",
      };
  }
};
