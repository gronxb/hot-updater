import { existsSync, statSync } from "fs";
import path from "path";

import {
  isServerDefinition,
  loadConfig,
  p,
  type ServerDefinition,
  serverDefinitionOf,
} from "@hot-updater/cli-tools";
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

/** Where a server-only project keeps its server definition, when no config points at one. */
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

const closeDatabaseOf =
  (configExports: Record<string, unknown>) => async (): Promise<void> => {
    const closeDatabase = configExports["closeDatabase"];
    if (typeof closeDatabase === "function") {
      await closeDatabase();
    }
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
    dispose: closeDatabaseOf(configExports),
  };
};

/**
 * The server definition to load: the path given, else the one `server` in
 * hot-updater.config.ts points at, else a server-only project's default.
 * A path given loads `.env.hotupdater`, which a definition init wrote reads,
 * without running hot-updater.config.ts; otherwise the config loads the
 * environment it loads.
 */
const resolveConfigPath = async (configPath: string, cwd: string) => {
  const trimmedConfigPath = configPath.trim();
  if (trimmedConfigPath) {
    const envFile = path.join(cwd, ".env.hotupdater");
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile);
    }
    return path.resolve(cwd, trimmedConfigPath);
  }
  const { server } = await loadConfig(null);
  if (typeof server === "string") {
    return server;
  }
  if (server !== undefined) {
    p.log.error(
      "hot-updater.config.ts reaches a self-hosted server through its admin API. Run this where the server's definition is, or pass its path.",
    );
    process.exit(1);
  }

  const defaultConfigPath = findDefaultConfigPath(cwd);
  if (defaultConfigPath) {
    return defaultConfigPath;
  }

  p.log.error(
    "Could not find a server definition: set server in hot-updater.config.ts, or pass its path.",
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
  const absoluteConfigPath = await resolveConfigPath(
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
        "    storage: [...],\n" +
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
        await closeDatabaseOf(configExports)();
      } finally {
        await removeGeneratedSchemaPlaceholder(generatedSchemaPlaceholderPath);
      }
    },
  };
}

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
