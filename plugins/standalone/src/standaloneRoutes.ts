export interface StandaloneRepositoryConfig {
  /** Base URL of the Hot Updater admin handler. */
  readonly baseUrl: string;
  /** Headers sent with every admin request, such as its authorization. */
  readonly commonHeaders?: Readonly<Record<string, string>>;
}
