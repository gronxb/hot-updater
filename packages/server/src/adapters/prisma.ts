import {
  createSqlAdapter,
  coreSettings,
  coreTarget,
  createEngineDatabase,
  createSettingsMigrator,
} from "@hot-updater/plugin-core";
import type {
  SchemaGenerator,
  ToolingDatabase,
} from "@hot-updater/plugin-core";

import {
  generatePrismaEngineSchema,
  prismaCollates,
  type PrismaProvider,
} from "../db/enginePrismaSchema";
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
  return {
    ...createEngineDatabase({
      name: "prisma",
      adapter: createSqlAdapter({ executor }),
    }),
    provider,
    generateSchema: ((version, _name, { schema } = coreTarget) => {
      if (version !== "latest" && version !== coreSettings["schema.core"]) {
        throw new Error(`Invalid version ${version}`);
      }
      return {
        code: generatePrismaEngineSchema(provider, schema),
        path: "prisma/schema.prisma",
      };
    }) satisfies SchemaGenerator,
    createMigrator: ({ schema, settings, ordered } = coreTarget) =>
      createSettingsMigrator({
        adapterName: "prisma",
        executor,
        schema,
        settings,
        ordered,
        applyTables: "`npx prisma db push`",
        collate: (column) => prismaCollates(provider, column),
      }),
  };
};
