import { afterAll, beforeAll, beforeEach, describe } from "vitest";

type Awaitable<T> = Promise<T> | T;

export type DatabasePluginTestLifecycle<TPlugin> = {
  readonly name: string;
  readonly createPlugin: () => Awaitable<TPlugin>;
  readonly migrate: () => Awaitable<void>;
  readonly reset: (plugin: TPlugin) => Awaitable<void>;
  readonly dispose: (plugin: TPlugin) => Awaitable<void>;
};

export type DatabasePluginTestState<TPlugin> = {
  readonly getPlugin: () => TPlugin;
};

class PluginUnavailableError extends Error {
  constructor() {
    super("The database plugin is unavailable outside the test lifecycle");
    this.name = "PluginUnavailableError";
  }
}

export const setupDatabasePluginTestRunner = <TPlugin>(
  lifecycle: DatabasePluginTestLifecycle<TPlugin>,
  registerTests: (state: DatabasePluginTestState<TPlugin>) => void,
): void => {
  describe(lifecycle.name, () => {
    let plugin: TPlugin | undefined;

    const getPlugin = (): TPlugin => {
      if (plugin === undefined) {
        throw new PluginUnavailableError();
      }
      return plugin;
    };

    beforeAll(async () => {
      await lifecycle.migrate();
      plugin = await lifecycle.createPlugin();
    });

    beforeEach(async () => {
      await lifecycle.reset(getPlugin());
    });

    afterAll(async () => {
      await lifecycle.dispose(getPlugin());
      plugin = undefined;
    });

    registerTests({ getPlugin });
  });
};
