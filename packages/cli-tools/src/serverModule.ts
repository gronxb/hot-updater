import { createJiti } from "jiti";

/** A server definition module, as the CLI and the console load it. */
export interface ServerModule {
  /** The module's absolute path. */
  readonly path: string;
  /**
   * Its `hotUpdater` export, or its default export: what
   * `createHotUpdater({ database, storage, plugins })` returned.
   */
  readonly hotUpdater: unknown;
  /**
   * Runs the module's optional `closeDatabase` export; whether it had one.
   * The module's server is the process's, so close it only when nothing
   * else in the process uses it.
   */
  closeDatabase(): Promise<boolean>;
}

/**
 * Imports the module at `absolutePath`, which defines the server. It is
 * loaded once per process, so every caller gets the same server, database
 * included: a long-lived process keeps it open between uses.
 */
export const importServerModule = async (
  absolutePath: string,
): Promise<ServerModule> => {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const exports = (await jiti.import(absolutePath)) as Record<string, unknown>;
  return {
    path: absolutePath,
    hotUpdater: exports["hotUpdater"] ?? exports["default"],
    closeDatabase: async () => {
      const closeDatabase = exports["closeDatabase"];
      if (typeof closeDatabase !== "function") return false;
      await closeDatabase();
      return true;
    },
  };
};
