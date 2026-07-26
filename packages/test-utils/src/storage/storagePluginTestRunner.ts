import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";
import { afterEach, beforeEach, describe } from "vitest";

type Awaitable<T> = Promise<T> | T;

export type StoragePluginTestLifecycle<
  TContext extends StorageOperationContext,
> = Readonly<{
  name: string;
  context: TContext;
  createPlugin: () => Awaitable<StoragePlugin<TContext>>;
}>;

export type StoragePluginTestState<TContext extends StorageOperationContext> =
  Readonly<{
    context: TContext;
    getPlugin: () => StoragePlugin<TContext>;
  }>;

class StoragePluginUnavailableError extends Error {
  constructor() {
    super("The storage plugin is unavailable outside the test lifecycle.");
    this.name = "StoragePluginUnavailableError";
  }
}

export const setupStoragePluginTestRunner = <
  TContext extends StorageOperationContext,
>(
  lifecycle: StoragePluginTestLifecycle<TContext>,
  registerTests: (state: StoragePluginTestState<TContext>) => void,
): void => {
  describe(lifecycle.name, () => {
    let plugin: StoragePlugin<TContext> | undefined;

    const getPlugin = (): StoragePlugin<TContext> => {
      if (plugin === undefined) {
        throw new StoragePluginUnavailableError();
      }
      return plugin;
    };

    beforeEach(async () => {
      plugin = await lifecycle.createPlugin();
    });

    afterEach(async () => {
      await getPlugin().onUnmount?.();
      plugin = undefined;
    });

    registerTests({ context: lifecycle.context, getPlugin });
  });
};
