import type { Lazy } from "@hot-updater/plugin-core";

export interface StandaloneRepositoryConfig {
  /** Base URL of the Hot Updater admin handler. */
  readonly baseUrl: string;
  /**
   * Headers sent with every admin request, such as its authorization. A
   * value may be a function that returns it, such as `secret("<name>")` in
   * `hot-updater.config.ts`, called on the first request.
   */
  readonly commonHeaders?: Readonly<Record<string, Lazy<string>>>;
}
