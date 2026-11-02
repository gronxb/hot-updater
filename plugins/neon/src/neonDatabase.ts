import {
  createEngineDatabase,
  createSqlAdapter,
  type ToolingDatabase,
} from "@hot-updater/plugin-core";
import { neon } from "@neondatabase/serverless";

import { neonExecutor } from "./neonExecutor";

export interface NeonDatabaseConfig {
  /**
   * The branch's Postgres connection string, pooled or direct: the
   * `DATABASE_URL` that `neon env pull` writes.
   */
  connectionString: string;
}

/**
 * Hot Updater's database on Neon's Postgres over HTTP: the storage engine
 * through the shared SQL core, fenced by the schema settings. Each query is
 * one HTTPS request, with no connection to open or pool to drain, so it runs
 * in Workers, edge functions, and serverless functions alike. HTTP has no
 * interactive transactions, so each write is one atomic batch that evaluates
 * its guards first (`_hu_write`). `hot-updater db migrate` creates core's
 * tables, the server's plugin tables, and the guard table, then writes their
 * settings rows.
 */
export const neonDatabase = ({
  connectionString,
}: NeonDatabaseConfig): ToolingDatabase =>
  createEngineDatabase({
    name: "neonDatabase",
    adapter: createSqlAdapter({
      executor: neonExecutor(neon(connectionString, { fullResults: true })),
    }),
  });
