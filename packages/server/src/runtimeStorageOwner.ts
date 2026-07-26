import {
  materializeRuntimeStorageInputSync,
  StorageConfigurationError,
  type NormalizedRuntimeStorageInput,
  type RuntimeStorageInput,
} from "@hot-updater/plugin-core";

export type RuntimeStorageOwner<TContext> = Readonly<{
  entries: readonly NormalizedRuntimeStorageInput<TContext>[];
  hasV2: boolean;
  close(): Promise<void>;
  rollback(): void;
}>;

const invokeRollbackHook = (plugin: object): void => {
  const hook = Reflect.get(plugin, "onUnmount");
  if (typeof hook !== "function") return;
  try {
    const result: unknown = Reflect.apply(hook, plugin, []);
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
  } catch {
    return;
  }
};

export const createRuntimeStorageOwner = <TContext>(
  inputs: readonly RuntimeStorageInput<TContext>[],
): RuntimeStorageOwner<TContext> => {
  const entries: NormalizedRuntimeStorageInput<TContext>[] = [];
  const owned: object[] = [];
  try {
    for (const input of inputs) {
      const entry = materializeRuntimeStorageInputSync(input);
      entries.push(entry);
      if (entry.origin === "factory") owned.push(entry.plugin);
    }
  } catch (error) {
    for (const plugin of owned.toReversed()) invokeRollbackHook(plugin);
    if (
      error instanceof StorageConfigurationError &&
      error.code === "invalid-storage-input" &&
      error.cause !== undefined
    ) {
      throw error.cause;
    }
    throw error;
  }

  let state: "open" | "rolled-back" | "closed" = "open";
  let closePromise: Promise<void> | undefined;
  const rollback = (): void => {
    if (state !== "open") return;
    state = "rolled-back";
    for (const plugin of owned.toReversed()) invokeRollbackHook(plugin);
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    if (state !== "open") {
      closePromise = Promise.resolve();
      return closePromise;
    }
    state = "closed";
    closePromise = (async () => {
      let firstError: unknown;
      for (const plugin of owned.toReversed()) {
        const hook = Reflect.get(plugin, "onUnmount");
        if (typeof hook !== "function") continue;
        try {
          await Reflect.apply(hook, plugin, []);
        } catch (error) {
          if (!(error instanceof Error)) {
            firstError ??= error;
            continue;
          }
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    })();
    return closePromise;
  };
  return Object.freeze({
    entries: Object.freeze(entries),
    hasV2: entries.some(({ plugin }) => "protocol" in plugin),
    close,
    rollback,
  });
};
