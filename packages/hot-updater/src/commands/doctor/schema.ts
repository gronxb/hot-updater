import { createMigrator } from "@hot-updater/cli-tools";
import { isRemoteDatabase } from "@hot-updater/plugin-core";

import { packageJsonData } from "../../packageJson";
import type { LoadedServer } from "../../utils/loadServer";
import {
  getRequiredUpdateTarget,
  type InfrastructureStatus,
} from "../doctorInfrastructure";
import { type InitProvider, INIT_PROVIDER_PACKAGES } from "../initProviders";
import type { DoctorContext } from "./context";
import type { SchemaIssue, SchemaSetting, SchemaStatus } from "./issues";
import type { ManagedDeployment } from "./managed";

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
 * different, core's and the plugins' together. Undefined when the fence
 * passes, or the read failed for another reason, which the server data checks
 * report.
 */
export const checkSchema = async (
  context: DoctorContext,
  infrastructure?: InfrastructureStatus,
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
    return schemaStatus(server, error, await v0VersionOf(server, error), {
      managed: await context.managed(),
      infrastructure,
    });
  }
};

/** The server that reads the database, as far as this doctor run sees it. */
interface ServerReading {
  /** The deployment init manages, whose server init redeploys. */
  readonly managed: ManagedDeployment | null;
  /** The server at `--server-base-url`, when doctor was given one. */
  readonly infrastructure: InfrastructureStatus | undefined;
}

/** That a server must change with the migration, and the order that keeps its downtime short. */
const SERVER_ORDER =
  "A server of an earlier release answers 503 once the database is migrated, and a server of this release answers 503 until it is";

/**
 * Why `--fix` leaves a migration to another command, and what to run: the
 * migration moves settings a running server of an earlier release passes on,
 * and doctor does not see that server at this release. Undefined when it may
 * migrate: nothing a running server reads changes, or `--server-base-url`
 * shows the server at this release.
 */
const waitsForServer = (
  pending: readonly SchemaSetting[],
  { managed, infrastructure }: ServerReading,
): string | undefined => {
  if (!pending.some(({ found }) => found !== null)) return undefined;
  const required = getRequiredUpdateTarget(packageJsonData.version).version;
  const behind =
    infrastructure?.needsUpdate === true && infrastructure.serverVersion
      ? `The server at ${infrastructure.baseUrl} runs ${infrastructure.serverVersion}, which answers 503 once this database is migrated.`
      : undefined;
  if (managed !== null) {
    if (infrastructure?.needsUpdate === false && !infrastructure.error) {
      return undefined;
    }
    const unseen =
      infrastructure?.error === undefined
        ? `doctor cannot see that ${managed.server} runs ${required}+ without --server-base-url`
        : `doctor could not read ${infrastructure.versionEndpoint} to see that ${managed.server} runs ${required}+ (${infrastructure.error})`;
    return `${behind ?? `${SERVER_ORDER}, and ${unseen}.`} Run \`${managed.command}\`: it applies this migration and redeploys ${managed.server} from this release in one run, so the 503 window is the deploy. Once ${managed.server} runs ${required}+, \`npx hot-updater doctor --fix --server-base-url <url>\` migrates the database instead.`;
  }
  if (behind === undefined) return undefined;
  return `${behind} Deploy the server from @hot-updater/server ${required}+ first, then rerun \`npx hot-updater doctor --fix --server-base-url ${infrastructure!.baseUrl}\`, or run \`npx hot-updater db migrate\` in the server's project as it deploys.`;
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
  reading: ServerReading,
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
      fixability: "blocked",
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
  if (changed.length > 0) {
    issues.push({
      type: "error",
      code: "PLUGIN_SCHEMA_CHANGED",
      message: `A plugin's version differs from the one the database recorded: ${listed(changed)}.`,
      resolution:
        "Apply the plugin's own migration for its changed tables, or use the plugin version that migrated the database; then run `npx hot-updater db migrate` in the server's project to record its version. doctor --fix creates missing tables and changes no existing one.",
      fixability: "blocked",
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
    const waits = waitsForServer(pending, reading);
    const { managed, infrastructure } = reading;
    // A self-hosted server doctor was not shown: its deploy is the user's.
    const unseen =
      managed === null &&
      infrastructure?.needsUpdate !== false &&
      pending.some(({ found }) => found !== null);
    issues.push({
      type: "error",
      code: "SCHEMA_MIGRATION_PENDING",
      message: `The database has migrations to run before the server reads it: ${listed(pending)}.`,
      resolution:
        waits ??
        (unseen
          ? `${pendingResolution(server)} ${SERVER_ORDER}: migrate it as you deploy the server from this release.`
          : pendingResolution(server)),
      settings: pending,
      fixability: "command",
      commands:
        waits !== undefined && managed !== null
          ? [managed.command]
          : migrationPath(server) === "orm"
            ? ["npx hot-updater db generate", "npx hot-updater db migrate"]
            : [DOCTOR_FIX],
      ...(waits === undefined ? {} : { waitsForServer: waits }),
    });
  }
  return { settings: [...settings], issues };
};

/** The settings the fence still refuses, read through the server once more. */
const stillRefused = async (
  server: LoadedServer,
): Promise<readonly SchemaSetting[]> => {
  try {
    await server.core.listChannels();
    return [];
  } catch (error) {
    return isSchemaMigrationRequired(error) ? error.settings : [];
  }
};

/** Whether a setting is a plugin's `schema.<id>`, not the engine's or core's. */
const isPluginSetting = (key: string) =>
  key !== "schema.engine" && key !== "schema.core";

/** What to run for settings the provider's migrations do not create. */
const uncoveredNote = (
  packageName: string,
  settings: readonly SchemaSetting[],
) =>
  `The migrations ${packageName} ships create core's tables and the official plugins'. ${settings.map(({ key }) => key).join(", ")} ${settings.length === 1 ? "belongs to a plugin" : "belong to plugins"} they do not create: run \`npx hot-updater db generate\` and apply the migration it writes.`;

/**
 * `hot-updater db migrate` over the config's database and plugins: it
 * creates missing tables, then writes the settings rows. That moves core's
 * and the official plugins' versions forward because their bumps only add
 * tables (`HOT_UPDATER_SCHEMA_VERSION`'s contract); another plugin's changed
 * version never reaches it.
 */
const runMigrator = async (
  database: Parameters<typeof createMigrator>[0]["database"],
  plugins: LoadedServer["plugins"],
  settings: readonly SchemaSetting[],
) => {
  const migration = await createMigrator({
    database,
    plugins,
  }).migrateToLatest({ updateSettings: true });
  await migration.execute();
  return {
    wrote:
      migration.operations.length === 0
        ? []
        : settings.map(({ key, expected }) => `${key} ${expected}`),
  };
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
): Promise<{ wrote: string[]; note?: string } | { skip: string }> => {
  const server = await context.server();
  if (server === null)
    throw new Error("hot-updater.config.ts names no database.");
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
        database,
        nonInteractive: context.nonInteractive,
      });
      const tooling = database as typeof database & {
        readonly createMigrator?: unknown;
      };
      if ("skip" in result) {
        // A database the provider's init did not create migrates as any other.
        return result.unmanaged && tooling.createMigrator !== undefined
          ? runMigrator(database, plugins, settings)
          : { skip: result.skip };
      }
      const applied = result.applied.map((name) => `migration ${name}`);
      // The provider's migrations create core's tables and the official
      // plugins'; a migrator creates any other plugin's.
      if (tooling.createMigrator !== undefined) {
        const { wrote } = await runMigrator(database, plugins, settings);
        return { wrote: [...applied, ...wrote] };
      }
      if (applied.length > 0) {
        // The provider's migrations may leave another plugin's settings.
        const left = await stillRefused(server);
        return left.length === 0
          ? { wrote: applied }
          : {
              wrote: applied,
              note: uncoveredNote(packageName, left),
            };
      }
      // Core's settings are the provider's migrations' to write.
      const behind = settings.filter(({ key }) => !isPluginSetting(key));
      const uncovered = settings.filter(({ key }) => isPluginSetting(key));
      return {
        skip: [
          ...(behind.length === 0
            ? []
            : [
                `${packageName} has no migration this database has not run for ${behind.map(({ key }) => key).join(", ")}; install the ${packageName} version that matches this hot-updater.`,
              ]),
          ...(uncovered.length === 0
            ? []
            : [uncoveredNote(packageName, uncovered)]),
        ].join(" "),
      };
    }
    case "migrator":
      return runMigrator(database, plugins, settings);
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
