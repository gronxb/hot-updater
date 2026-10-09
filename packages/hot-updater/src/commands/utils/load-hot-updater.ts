import { existsSync, statSync } from "fs";
import path from "path";

import {
  isServerDefinition,
  loadConfig,
  p,
  type ServerDefinition,
  serverDefinitionOf,
} from "@hot-updater/cli-tools";
import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import { createJiti } from "jiti";

import { ui } from "../../utils/cli-ui";
import {
  createGeneratedSchemaPlaceholder,
  removeGeneratedSchemaPlaceholder,
  resolveGeneratedSchemaPlaceholderPath,
} from "./generated-schema-placeholder";

export interface LoadHotUpdaterResult {
  /** What `createHotUpdater` returned. */
  hotUpdater: ServerDefinition;
  adapterName: string;
  absoluteConfigPath: string;
  dispose: () => Promise<void>;
}

const SUPPORTED_CONFIG_EXTENSIONS = [
  "ts",
  "cts",
  "mts",
  "js",
  "cjs",
  "mjs",
] as const;

/** Where a server project keeps its server definition, when no path is given. */
const DEFAULT_CONFIG_BASENAMES = [
  path.join("src", "hotUpdater"),
  path.join("src", "db"),
] as const;

interface LoadHotUpdaterOptions {
  cwd?: string;
  allowGeneratedSchemaPlaceholder?: boolean;
}

/** The default config paths that exist, in the order the loader tries them. */
export const findDefaultConfigPaths = (cwd: string): string[] =>
  DEFAULT_CONFIG_BASENAMES.flatMap((basename) =>
    SUPPORTED_CONFIG_EXTENSIONS.map((ext) =>
      path.resolve(cwd, `${basename}.${ext}`),
    ),
  ).filter((candidate) => existsSync(candidate));

const findDefaultConfigPath = (cwd: string) =>
  findDefaultConfigPaths(cwd)[0] ?? null;

/** Whether `value` names a file the loader can import, such as `src/hotUpdater.ts`. */
export const isConfigFile = (value: string, cwd: string): boolean => {
  if (!SUPPORTED_CONFIG_EXTENSIONS.some((ext) => value.endsWith(`.${ext}`))) {
    return false;
  }
  const candidate = path.resolve(cwd, value);
  return existsSync(candidate) && statSync(candidate).isFile();
};

/**
 * Closes what the server definition opened: its module's `closeDatabase`
 * export when it has one, else its database's own `dispose`.
 */
const closeDatabaseOf =
  (
    configExports: Record<string, unknown>,
    hotUpdater: { readonly database: { dispose?(): Promise<void> } },
  ) =>
  async (): Promise<void> => {
    const closeDatabase = configExports["closeDatabase"];
    if (typeof closeDatabase === "function") {
      await closeDatabase();
      return;
    }
    await hotUpdater.database.dispose?.();
  };

/**
 * The hotUpdater instance a config file exports, or undefined when it
 * exports none, such as a `defineConfig` file. An import error throws.
 */
export const importHotUpdater = async (
  absoluteConfigPath: string,
): Promise<LoadHotUpdaterResult | undefined> => {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const configExports = (await jiti.import(absoluteConfigPath)) as Record<
    string,
    unknown
  >;
  const hotUpdater = configExports["hotUpdater"] ?? configExports["default"];
  if (!isServerDefinition(hotUpdater)) return undefined;
  return {
    hotUpdater,
    adapterName: hotUpdater.database.name,
    absoluteConfigPath,
    dispose: closeDatabaseOf(configExports, hotUpdater),
  };
};

/**
 * The server definition to load: the path given, else a server project's
 * default, `src/hotUpdater.*` or `src/db.*`. A path given loads
 * `.env.hotupdater`, which the definition may read, without running
 * hot-updater.config.ts.
 */
const resolveConfigPath = (configPath: string, cwd: string) => {
  const trimmedConfigPath = configPath.trim();
  if (trimmedConfigPath) {
    const envFile = path.join(cwd, ".env.hotupdater");
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile);
    }
    return path.resolve(cwd, trimmedConfigPath);
  }

  const defaultConfigPath = findDefaultConfigPath(cwd);
  if (defaultConfigPath) {
    return defaultConfigPath;
  }

  p.log.error(
    "Could not find a server definition: pass its path, or keep it in src/hotUpdater.ts or src/db.ts.",
  );
  p.log.message(
    ui.block("Examples", [
      ui.kv("Generate", ui.command("hot-updater db generate src/db.ts")),
      ui.kv("Migrate", ui.command("hot-updater db migrate src/db.ts")),
      ui.kv("SQL", ui.command("hot-updater db generate --sql")),
    ]),
  );
  process.exit(1);
};

/**
 * Load and validate hotUpdater instance from config file
 */
export async function loadHotUpdater(
  configPath: string,
  options: LoadHotUpdaterOptions = {},
): Promise<LoadHotUpdaterResult> {
  const absoluteConfigPath = resolveConfigPath(
    configPath,
    options.cwd ?? process.cwd(),
  );

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(
      ui.line(["Config file not found:", ui.path(absoluteConfigPath)]),
    );
    process.exit(1);
  }

  if (statSync(absoluteConfigPath).isDirectory()) {
    p.log.error(
      ui.line(["Config path must be a file:", ui.path(absoluteConfigPath)]),
    );
    process.exit(1);
  }

  // Load config file using jiti
  const jiti = createJiti(import.meta.url, { interopDefault: true });

  let moduleExports: Record<string, unknown> | undefined;
  let generatedSchemaPlaceholderPath: string | undefined;
  const exitAfterPlaceholderCleanup = async (): Promise<never> => {
    await removeGeneratedSchemaPlaceholder(generatedSchemaPlaceholderPath);
    process.exit(1);
  };

  try {
    moduleExports = (await jiti.import(absoluteConfigPath)) as Record<
      string,
      unknown
    >;
  } catch (importError) {
    const placeholderPath =
      options.allowGeneratedSchemaPlaceholder === true
        ? resolveGeneratedSchemaPlaceholderPath(
            importError,
            options.cwd ?? process.cwd(),
          )
        : undefined;

    if (placeholderPath) {
      await createGeneratedSchemaPlaceholder(placeholderPath);
      generatedSchemaPlaceholderPath = placeholderPath;

      try {
        moduleExports = (await jiti.import(absoluteConfigPath)) as Record<
          string,
          unknown
        >;
      } catch (retryError) {
        await removeGeneratedSchemaPlaceholder(generatedSchemaPlaceholderPath);
        reportConfigImportError(retryError);
      }
    } else {
      reportConfigImportError(importError);
    }
  }

  if (!moduleExports) {
    p.log.error("Failed to load configuration file.");
    await exitAfterPlaceholderCleanup();
    throw new Error("Failed to load configuration file.");
  }

  const configExports = moduleExports;

  // Extract hotUpdater instance
  const exported = configExports["hotUpdater"] || configExports["default"];

  if (!exported) {
    p.log.error(
      'Could not find "hotUpdater" export in the config file.\n\n' +
        "Your config file should export a hotUpdater instance:\n\n" +
        "  import { createHotUpdater } from '@hot-updater/server';\n" +
        "  import { kyselyAdapter } from '@hot-updater/server/adapters/kysely';\n\n" +
        "  export const hotUpdater = createHotUpdater({\n" +
        "    database: kyselyAdapter({ db: kysely, provider: 'postgresql' }),\n" +
        "    storage: s3Storage({ ... }),\n" +
        "    plugins: [...],\n" +
        "  });",
    );
    await exitAfterPlaceholderCleanup();
    throw new Error('Could not find "hotUpdater" export.');
  }

  let hotUpdater: ServerDefinition;
  try {
    hotUpdater = serverDefinitionOf(exported, absoluteConfigPath);
  } catch (error) {
    p.log.error(
      `${(error as Error).message} Use @hot-updater/server's createHotUpdater().`,
    );
    await exitAfterPlaceholderCleanup();
    throw new Error("The hotUpdater instance is not valid.");
  }

  return {
    hotUpdater,
    adapterName: hotUpdater.database.name,
    absoluteConfigPath,
    dispose: async () => {
      try {
        await closeDatabaseOf(configExports, hotUpdater)();
      } finally {
        await removeGeneratedSchemaPlaceholder(generatedSchemaPlaceholderPath);
      }
    },
  };
}

/** A project's plugin list, and the file it comes from. */
export interface FoundPluginList {
  /** The file that lists the plugins, for messages. */
  readonly from: string;
  readonly plugins: readonly AnyHotUpdaterPlugin[];
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The project's plugin list, in order: the server definition `args` names,
 * then `plugins` in hot-updater.config.ts when it lists any, then the first
 * of `src/hotUpdater.*` and `src/db.*` that exports a server definition.
 * Undefined when the project has none; a default that fails to load is
 * reported in `failures` and skipped.
 */
export const findPluginList = async (
  args: readonly string[],
  cwd: string,
  failures: string[] = [],
): Promise<FoundPluginList | undefined> => {
  const named = args.find(
    (arg) => !arg.startsWith("-") && isConfigFile(arg, cwd),
  );
  if (named !== undefined) {
    const loaded = await loadHotUpdater(named, { cwd });
    await loaded.dispose();
    return {
      from: path.relative(cwd, loaded.absoluteConfigPath),
      plugins: loaded.hotUpdater.plugins,
    };
  }
  // Loading the config opens its database, which this does not read.
  const { database, plugins } = await loadConfig(null);
  await database?.dispose?.();
  if (plugins.length > 0) return { from: "hot-updater.config.ts", plugins };
  for (const configPath of findDefaultConfigPaths(cwd)) {
    let loaded: LoadHotUpdaterResult | undefined;
    try {
      loaded = await importHotUpdater(configPath);
    } catch (error) {
      failures.push(`${path.relative(cwd, configPath)}: ${messageOf(error)}`);
      continue;
    }
    if (loaded === undefined) continue;
    await loaded.dispose();
    return {
      from: path.relative(cwd, configPath),
      plugins: loaded.hotUpdater.plugins,
    };
  }
  return undefined;
};

const reportConfigImportError = (importError: unknown): never => {
  const errorMessage =
    importError instanceof Error ? importError.message : String(importError);

  if (errorMessage.includes("is not a function")) {
    p.log.error(
      "Failed to load the config file due to an import error.\n" +
        "This usually happens when:\n" +
        "  1. '@hot-updater/server' package is not installed\n" +
        "  2. The import statement is incorrect\n\n" +
        "Solutions:\n" +
        "  • Run: pnpm install @hot-updater/server\n" +
        "  • Verify your import: import { createHotUpdater } from '@hot-updater/server'\n" +
        "  • Ensure you're exporting: export const hotUpdater = createHotUpdater({...})",
    );
  } else if (
    errorMessage.includes("Cannot find module") ||
    errorMessage.includes("Cannot find package")
  ) {
    p.log.error(
      "Failed to load required dependencies.\n\n" +
        "Please run: pnpm install\n\n" +
        "If the error persists, check that all packages in your config file are installed.",
    );
  } else {
    p.log.error(
      `Failed to load configuration file: ${errorMessage}\n\n` +
        "Please check:\n" +
        "  • The config file syntax is valid TypeScript/JavaScript\n" +
        "  • All imported packages are installed\n" +
        "  • The file path is correct",
    );
  }

  if (process.env["DEBUG"]) {
    console.error("\nDetailed error:");
    console.error(importError);
  } else {
    p.log.info("Run with DEBUG=1 for more details");
  }

  process.exit(1);
};
