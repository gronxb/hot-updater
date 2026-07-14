import { afterAll, beforeAll, beforeEach, describe } from "vitest";

type Awaitable<T> = Promise<T> | T;

export type DatabaseAdapterTestLifecycle<TAdapter, TContext> = {
  readonly name: string;
  readonly createAdapter: () => Awaitable<TAdapter>;
  readonly migrate: () => Awaitable<void>;
  readonly reset: (adapter: TAdapter) => Awaitable<void>;
  readonly dispose: (adapter: TAdapter) => Awaitable<void>;
  readonly context?: TContext;
};

export type DatabaseAdapterTestState<TAdapter, TContext> = {
  readonly context: TContext | undefined;
  readonly getAdapter: () => TAdapter;
};

class AdapterUnavailableError extends Error {
  constructor() {
    super("The database adapter is unavailable outside the test lifecycle");
    this.name = "AdapterUnavailableError";
  }
}

export const setupDatabaseAdapterTestRunner = <TAdapter, TContext>(
  lifecycle: DatabaseAdapterTestLifecycle<TAdapter, TContext>,
  registerTests: (state: DatabaseAdapterTestState<TAdapter, TContext>) => void,
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

    registerTests({
      context: lifecycle.context,
      getAdapter,
    });
  });
};
