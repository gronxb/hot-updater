import {
  createKyselyDatabase,
  type RelationMode,
} from "@hot-updater/server/adapters/kysely";
import type { DatabaseAdapterRuntime } from "@hot-updater/server/db";
import type { Dialect } from "kysely";

import { D1RestDialect } from "./node/d1RestDialect";

export interface D1DatabaseConfig {
  readonly accountId: string;
  readonly cloudflareApiToken: string;
  readonly databaseId: string;
  readonly relationMode?: RelationMode;
}

export interface D1DialectDatabaseConfig {
  readonly dialect: Dialect;
  readonly relationMode?: RelationMode;
}

export type D1DatabaseOptions = D1DatabaseConfig | D1DialectDatabaseConfig;
export type D1DatabaseRuntime = DatabaseAdapterRuntime;

const resolveDialect = (config: D1DatabaseOptions): Dialect =>
  "dialect" in config
    ? config.dialect
    : new D1RestDialect({
        accountId: config.accountId,
        cloudflareApiToken: config.cloudflareApiToken,
        databaseId: config.databaseId,
      });

export const d1Database = (config: D1DatabaseOptions): D1DatabaseRuntime =>
  createKyselyDatabase({
    dialect: resolveDialect(config),
    provider: "sqlite",
    transactionMode: "disabled",
    ...(config.relationMode ? { relationMode: config.relationMode } : {}),
  });
