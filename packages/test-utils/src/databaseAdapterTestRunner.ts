import { afterAll, beforeAll, beforeEach, describe } from "vitest";

type Awaitable<T> = Promise<T> | T;

export type DatabaseAdapterTestLifecycle<TAdapter> = {
  readonly name: string;
  readonly createAdapter: () => Awaitable<TAdapter>;
  readonly migrate: () => Awaitable<void>;
  readonly reset: (adapter: TAdapter) => Awaitable<void>;
  readonly dispose: (adapter: TAdapter) => Awaitable<void>;
};

export type DatabaseAdapterTestState<TAdapter> = {
  readonly getAdapter: () => TAdapter;
};

class AdapterUnavailableError extends Error {
  constructor() {
    super("The database adapter is unavailable outside the test lifecycle");
    this.name = "AdapterUnavailableError";
  }
}

export const setupDatabaseAdapterTestRunner = <TAdapter>(
  lifecycle: DatabaseAdapterTestLifecycle<TAdapter>,
  registerTests: (state: DatabaseAdapterTestState<TAdapter>) => void,
): void => {
  describe(lifecycle.name, () => {
    let adapter: TAdapter | undefined;

    const getAdapter = (): TAdapter => {
      if (adapter === undefined) {
        throw new AdapterUnavailableError();
      }
      return adapter;
    };

    beforeAll(async () => {
      await lifecycle.migrate();
      adapter = await lifecycle.createAdapter();
    });

    beforeEach(async () => {
      await lifecycle.reset(getAdapter());
    });

    afterAll(async () => {
      await lifecycle.dispose(getAdapter());
      adapter = undefined;
    });

    registerTests({ getAdapter });
  });
};
