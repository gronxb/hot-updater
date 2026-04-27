import { drizzleAdapter as fumadbDrizzleAdapter } from "fumadb/adapters/drizzle";

import type { ORMDatabaseAdapter } from "../db/types";

type SQLProvider = "postgresql" | "mysql" | "sqlite";

export type DrizzleConfig = Parameters<typeof fumadbDrizzleAdapter>[0];

export const drizzleAdapter = (config: DrizzleConfig): ORMDatabaseAdapter =>
  Object.assign(
    fumadbDrizzleAdapter(
      config as unknown as Parameters<typeof fumadbDrizzleAdapter>[0],
    ) as unknown as ORMDatabaseAdapter,
    {
      __hotUpdaterProvider: config.provider as SQLProvider | undefined,
    },
  );
