import type { RequestEnvContext } from "@hot-updater/plugin-core";
import { createKyselyDatabase } from "@hot-updater/server/adapters/kysely";
import type { DatabaseAdapterRuntime } from "@hot-updater/server/db";
import { D1Dialect, type D1DialectConfig } from "kysely-d1";

export interface CloudflareWorkerDatabaseEnv {
  readonly DB: D1DialectConfig["database"];
}

export type CloudflareWorkerDatabaseRuntime = DatabaseAdapterRuntime;

const resolveDbFromContext = (
  context?: RequestEnvContext<CloudflareWorkerDatabaseEnv>,
) => {
  const db = context?.env?.DB;

  if (!db) {
    throw new Error(
      "d1WorkerDatabase requires env.DB in the hot updater context.",
    );
  }

  return db;
};

export const d1WorkerDatabase =
  <
    TContext extends RequestEnvContext<CloudflareWorkerDatabaseEnv> =
      RequestEnvContext<CloudflareWorkerDatabaseEnv>,
  >() =>
  (context?: TContext): CloudflareWorkerDatabaseRuntime =>
    createKyselyDatabase({
      dialect: new D1Dialect({ database: resolveDbFromContext(context) }),
      provider: "sqlite",
      transactionMode: "disabled",
    });
