import {
  createLegacyDatabasePlugin,
  legacyFacadeSchema,
  legacyFacadeSettings,
} from "../database/legacyFacade";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import {
  generatePrismaEngineSchema,
  prismaCollationStatements,
  type PrismaProvider,
} from "../db/enginePrismaSchema";
import { createSettingsMigrator } from "../db/settingsMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  SchemaGenerator,
} from "../db/types";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import {
  prismaExecutor,
  type PrismaTransactionalClient,
} from "./prismaExecutor";

export type { PrismaProvider };

export interface PrismaConfig {
  /** A Prisma client: raw queries and interactive transactions run on it. */
  readonly prisma: object;
  readonly provider: PrismaProvider;
  /** Ignored: the engine keeps references itself, so the models have no relations. */
  readonly relationMode?: "prisma" | "foreign-keys";
  /** Ignored. */
  readonly db?: unknown;
}

/**
 * Hot Updater's database on a Prisma client: the storage engine through the
 * shared SQL core, behind today's `DatabasePlugin` until E2. `db generate`
 * writes the models Prisma applies; `db migrate` then sets the collations
 * Prisma cannot declare and writes the settings rows the schema fence checks.
 * CockroachDB runs as PostgreSQL until E2 removes it.
 */
export const prismaAdapter = (
  config: PrismaConfig,
): DatabaseAdapterWithCapabilities => {
  if ((config.provider as string) === "mssql") {
    throw new Error(
      "prismaAdapter: SQL Server is not supported. Use PostgreSQL, MySQL, or SQLite.",
    );
  }
  const executor = prismaExecutor(
    config.prisma as PrismaTransactionalClient,
    config.provider === "cockroachdb" ? "postgresql" : config.provider,
  );
  const collations = prismaCollationStatements(
    config.provider,
    legacyFacadeSchema,
  );
  return {
    ...createLegacyDatabasePlugin({
      name: "prisma",
      adapter: createSqlAdapter({ executor }),
      fence: true,
    }),
    adapterName: "prisma",
    provider: config.provider,
    generateSchema: ((version) => {
      if (version !== "latest" && version !== HOT_UPDATER_SCHEMA_VERSION) {
        throw new Error(`Invalid version ${version}`);
      }
      return {
        code: generatePrismaEngineSchema(config.provider, legacyFacadeSchema),
        path: "prisma/schema.prisma",
      };
    }) satisfies SchemaGenerator,
    createMigrator: () =>
      createSettingsMigrator({
        adapterName: "prisma",
        executor,
        settings: legacyFacadeSettings,
        applyTables: "`prisma db push` (or `prisma migrate`)",
        ...(collations.length === 0
          ? {}
          : {
              fixups: {
                description:
                  "Set the collations Prisma cannot declare, so strings compare by their bytes",
                statements: collations,
              },
            }),
      }),
  };
};
