/**
 * The shapes `@hot-updater/test-utils` passes a plugin's suite, restated
 * here so the plugin's tests need no dependency on that package.
 */
export type HttpTestRequest = (
  path: string,
  init?: NonNullable<ConstructorParameters<typeof Request>[1]>,
) => Promise<Response>;

/** A running server's client and admin mounts. */
export interface HttpTestClient {
  readonly client: HttpTestRequest;
  readonly admin: HttpTestRequest;
}

export type DatabaseTestState<TDatabase> = {
  readonly getDatabase: () => TDatabase;
};

type Awaitable<T> = Promise<T> | T;

/** How a suite gets a database, and gives it back. */
export type DatabaseTestLifecycle<TDatabase> = {
  readonly name: string;
  readonly migrate: () => Awaitable<void>;
  readonly createDatabase: () => Awaitable<TDatabase>;
  /** Empties every table between tests. */
  readonly reset: (database: TDatabase) => Awaitable<void>;
  readonly dispose: (database: TDatabase) => Awaitable<void>;
};
