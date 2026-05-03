import { mongoAdapter as fumadbMongoAdapter } from "fumadb/adapters/mongodb";

import type { ORMDatabaseAdapter } from "../db/types";

export interface MongoDBConfig<TClient extends object = object> {
  client: TClient;
}

export const mongoAdapter = <TClient extends object>(
  options: MongoDBConfig<TClient>,
): ORMDatabaseAdapter =>
  Object.assign(
    fumadbMongoAdapter(
      options as unknown as Parameters<typeof fumadbMongoAdapter>[0],
    ) as unknown as ORMDatabaseAdapter,
    {
      provider: "mongodb",
    },
  );
