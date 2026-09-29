import { afterAll, beforeAll, beforeEach, describe } from "vitest";

type Awaitable<T> = Promise<T> | T;

/** How a suite gets a provider's database, and gives it back. */
export type DatabaseTestLifecycle<TDatabase> = {
  readonly name: string;
  /** Creates the provider's tables and settings rows, before `createDatabase`. */
  readonly migrate: () => Awaitable<void>;
  /** The provider's database, as its factory returns it. */
  readonly createDatabase: () => Awaitable<TDatabase>;
  /** Empties every table between tests. */
  readonly reset: (database: TDatabase) => Awaitable<void>;
  readonly dispose: (database: TDatabase) => Awaitable<void>;
};

export type DatabaseTestState<TDatabase> = {
  readonly getDatabase: () => TDatabase;
};

class DatabaseUnavailableError extends Error {
  constructor() {
    super("The database is unavailable outside the test lifecycle");
    this.name = "DatabaseUnavailableError";
  }
}

export const setupDatabaseTestRunner = <TDatabase>(
  lifecycle: DatabaseTestLifecycle<TDatabase>,
  registerTests: (state: DatabaseTestState<TDatabase>) => void,
): void => {
  describe(lifecycle.name, () => {
    let database: TDatabase | undefined;

    const getDatabase = (): TDatabase => {
      if (database === undefined) throw new DatabaseUnavailableError();
      return database;
    };

    beforeAll(async () => {
      await lifecycle.migrate();
      database = await lifecycle.createDatabase();
    });

    beforeEach(async () => {
      await lifecycle.reset(getDatabase());
    });

    afterAll(async () => {
      await lifecycle.dispose(getDatabase());
      database = undefined;
    });

    registerTests({ getDatabase });
  });
};
