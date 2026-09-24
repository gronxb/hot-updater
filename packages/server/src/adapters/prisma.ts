import {
  builtInSchema,
  builtInSettings,
  createEngineDatabase,
} from "../database/builtInDatabase";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import {
  generatePrismaEngineSchema,
  prismaCollationStatements,
  type PrismaProvider,
} from "../db/enginePrismaSchema";
import { createSettingsMigrator } from "../db/settingsMigrator";
import type { SchemaGenerator, ToolingDatabase } from "../db/types";
import {
  prismaExecutor,
  type PrismaTransactionalClient,
} from "./prismaExecutor";
import { checkSqlProvider } from "./sqlProviders";

export type { PrismaProvider };

export interface PrismaConfig {
  /** A Prisma client: raw queries and interactive transactions run on it. */
  readonly prisma: object;
  readonly provider: PrismaProvider;
}

/**
 * Hot Updater's database on a Prisma client: the storage engine through the
 * shared SQL core, fenced by the schema settings. `db generate` writes the
 * models Prisma applies; `db migrate` then sets the collations Prisma cannot
 * declare and writes the settings rows the fence checks.
 */
export const prismaAdapter = (config: PrismaConfig): ToolingDatabase => {
  const provider = checkSqlProvider("prismaAdapter", config.provider);
  const executor = prismaExecutor(
    config.prisma as PrismaTransactionalClient,
    provider,
  );
  const collations = prismaCollationStatements(provider, builtInSchema);
  return {
    ...createEngineDatabase({
      name: "prisma",
      adapter: createSqlAdapter({ executor }),
    }),
    provider,
    generateSchema: ((version) => {
      if (version !== "latest" && version !== builtInSettings["schema.core"]) {
        throw new Error(`Invalid version ${version}`);
      }
      return {
        code: generatePrismaEngineSchema(provider, builtInSchema),
        path: "prisma/schema.prisma",
      };
    }) satisfies SchemaGenerator,
    createMigrator: () =>
      createSettingsMigrator({
        adapterName: "prisma",
        executor,
        settings: builtInSettings,
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
