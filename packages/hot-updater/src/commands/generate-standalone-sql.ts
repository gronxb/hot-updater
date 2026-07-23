import { access, mkdir, writeFile } from "fs/promises";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import {
  formatDialect,
  mysql as mysqlDialect,
  postgresql as postgresqlDialect,
  sqlite as sqliteDialect,
} from "sql-formatter";

import { ui } from "../utils/cli-ui";

const SUPPORTED_PROVIDERS = ["postgresql", "mysql", "sqlite"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const isSupportedProvider = (provider: string): provider is SupportedProvider =>
  SUPPORTED_PROVIDERS.includes(provider as SupportedProvider);

const createDummyPostgresPool = () => ({
  connect: async () => ({
    query: async () => ({
      rows: [],
      command: "SELECT" as const,
      rowCount: 0,
    }),
    release: () => {},
  }),
  end: async () => {},
});

const createDummyMysqlPool = () => ({
  getConnection: (
    callback: (
      error: Error | null,
      connection?: {
        query: (
          sql: string,
          parameters: readonly unknown[],
          queryCallback: (error: Error | null, result?: unknown[]) => void,
        ) => void;
        release: () => void;
      },
    ) => void,
  ) => {
    callback(null, {
      query: (_sql, _parameters, queryCallback) => {
        queryCallback(null, []);
      },
      release: () => {},
    });
  },
  end: (callback: (error?: Error) => void) => {
    callback();
  },
});

const createDummySqliteDatabase = () => ({
  close: async () => {},
  prepare: () => ({
    all: async () => [],
    get: async () => undefined,
    run: async () => ({ changes: 0 }),
    finalize: async () => {},
  }),
});

const createDialect = (provider: SupportedProvider) => {
  switch (provider) {
    case "postgresql":
      return new PostgresDialect({ pool: createDummyPostgresPool() as never });
    case "mysql":
      return new MysqlDialect({ pool: createDummyMysqlPool() as never });
    case "sqlite":
      return new SqliteDialect({
        database: createDummySqliteDatabase() as never,
      });
  }
};

const getProvider = async (
  provider: string | undefined,
  skipConfirm: boolean,
): Promise<SupportedProvider> => {
  if (provider) {
    if (!isSupportedProvider(provider)) {
      p.log.error(
        `Invalid provider: ${provider}\nValid options: ${SUPPORTED_PROVIDERS.join(", ")}`,
      );
      process.exit(1);
    }
    return provider;
  }

  if (skipConfirm) return "postgresql";

  const selected = await p.select({
    message: "Select database type",
    options: [
      { value: "postgresql", label: "PostgreSQL" },
      { value: "mysql", label: "MySQL" },
      { value: "sqlite", label: "SQLite" },
    ],
  });

  if (p.isCancel(selected)) {
    p.cancel("Operation cancelled");
    process.exit(0);
  }

  if (typeof selected === "string" && isSupportedProvider(selected)) {
    return selected;
  }

  p.log.error(
    `Invalid provider: ${String(selected)}\nValid options: ${SUPPORTED_PROVIDERS.join(", ")}`,
  );
  process.exit(1);
};

export async function generateStandaloneSQL(options: {
  outputDir: string;
  skipConfirm: boolean;
  provider?: string;
}) {
  const { outputDir, skipConfirm, provider } = options;

  try {
    const dbType = await getProvider(provider, skipConfirm);
    const s = p.spinner();
    s.start("Generating SQL from database schema");

    const db = new Kysely({ dialect: createDialect(dbType) });
    const [{ createHotUpdater }, { createMigrator }, { kyselyAdapter }] =
      await Promise.all([
        import("@hot-updater/server"),
        import("@hot-updater/server/db"),
        import("@hot-updater/server/adapters/kysely"),
      ]);

    const adapter = kyselyAdapter({
      db,
      provider: dbType,
    });

    const hotUpdater = createHotUpdater({
      database: adapter,
    });
    const migrator = createMigrator(hotUpdater);
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: false,
    });

    s.stop("SQL generation complete");

    if (!result.getSQL) {
      p.log.error(
        "SQL generation is not supported by the database plugin.\n" +
          "This may indicate a configuration issue.",
      );
      process.exit(1);
    }

    const sql = result.getSQL();
    if (!sql || sql.trim() === "") {
      p.log.error(
        "No SQL was generated from the schema.\n" +
          "The schema may be empty or invalid.",
      );
      process.exit(1);
    }

    const formatterDialects = {
      postgresql: postgresqlDialect,
      mysql: mysqlDialect,
      sqlite: sqliteDialect,
    } as const;
    const formattedSql = formatDialect(sql, {
      dialect: formatterDialects[dbType],
      tabWidth: 2,
      keywordCase: "upper",
    });

    const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
    await mkdir(absoluteOutputDir, { recursive: true });
    const outputPath = path.join(absoluteOutputDir, "hot-updater.sql");
    const outputExists = await access(outputPath)
      .then(() => true)
      .catch(() => false);

    if (!skipConfirm) {
      p.log.message(ui.title("SQL preview"));
      console.log(formattedSql);
      console.log("");

      if (outputExists) {
        p.log.warn("This will overwrite existing hot-updater.sql");
      }

      const shouldContinue = await p.confirm({
        message: "Save to hot-updater.sql?",
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel("Operation cancelled");
        process.exit(0);
      }
    } else if (outputExists) {
      p.log.warn("Overwriting existing hot-updater.sql");
    }

    await writeFile(outputPath, formattedSql, "utf-8");
    p.log.success(ui.line(["Created", ui.path(outputPath)]));
  } catch (error) {
    p.log.error("Failed to generate standalone SQL");
    if (error instanceof Error) {
      p.log.error(error.message);
      if (process.env["DEBUG"]) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}
