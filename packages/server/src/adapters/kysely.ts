import { kyselyAdapter as fumadbKyselyAdapter } from "fumadb/adapters/kysely";

import type { ORMDatabaseAdapter } from "../db/types";

export type RelationMode = import("fumadb").RelationMode;
export type SQLProvider = import("fumadb").SQLProvider;

export interface KyselyConfig<TDatabase extends object = object> {
  db: TDatabase;
  provider: SQLProvider;
  relationMode?: RelationMode;
}

export const kyselyAdapter = <TDatabase extends object>(
  config: KyselyConfig<TDatabase>,
): ORMDatabaseAdapter =>
  fumadbKyselyAdapter(
    config as unknown as Parameters<typeof fumadbKyselyAdapter>[0],
  ) as unknown as ORMDatabaseAdapter;
