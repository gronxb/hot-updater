import type { StorageAdapter } from "@hot-updater/plugin-core";

export interface StandaloneRepositoryConfig {
  /** Base URL of the Hot Updater admin handler. */
  readonly baseUrl: string;
  /** Headers sent with every admin request, such as its authorization. */
  readonly commonHeaders?: Readonly<Record<string, string>>;
}

export interface StandaloneServerConfig extends StandaloneRepositoryConfig {
  /**
   * Where the server's bundles are stored: the CLI uploads to the first, and
   * the console reads and deletes each bundle's files with the adapter of
   * their protocol.
   */
  readonly storage: readonly StorageAdapter[];
}
