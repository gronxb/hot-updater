import type {
  ConfigInput,
  NodeStoragePlugin,
  NormalizedStorageInput,
  RequiredDeep,
  StorageOperationContext,
} from "@hot-updater/plugin-core";
import {
  materializeStorageInput,
  StorageConfigurationError,
} from "@hot-updater/plugin-core";
import {
  type BorrowedNodeStoragePlugin,
  createNodeStorageContext,
  createNodeStoragePluginFacade,
} from "@hot-updater/plugin-core/storage/node";

export type ConfigResponse = Omit<RequiredDeep<ConfigInput>, "storage"> & {
  storage(
    context?: StorageOperationContext,
  ): BorrowedNodeStoragePlugin | Promise<BorrowedNodeStoragePlugin>;
  disposeStorage(): Promise<void>;
};

export const createConfigResponse = (
  config: RequiredDeep<ConfigInput>,
): ConfigResponse => {
  const storageInput = config.storage;
  let storagePromise:
    | Promise<NormalizedStorageInput<NodeStoragePlugin>>
    | undefined;
  let disposePromise: Promise<void> | undefined;
  let disposed = false;

  const getNormalizedStorage = () => {
    if (disposed) {
      throw new StorageConfigurationError(
        "disposed",
        "This configuration response has already disposed its storage.",
      );
    }
    if (storagePromise !== undefined) {
      return storagePromise;
    }

    const attempt = materializeStorageInput<NodeStoragePlugin>(storageInput);
    storagePromise = attempt;
    void attempt.catch(() => {
      if (storagePromise === attempt) {
        storagePromise = undefined;
      }
    });
    return attempt;
  };

  const storage = async (
    context?: StorageOperationContext,
  ): Promise<BorrowedNodeStoragePlugin> => {
    const normalized = await getNormalizedStorage();
    if (disposed) {
      throw new StorageConfigurationError(
        "disposed",
        "This configuration response has already disposed its storage.",
      );
    }

    if (normalized.origin === "factory") {
      const plugin = normalized.plugin;
      return Object.freeze({
        name: plugin.name,
        profiles: plugin.profiles,
        supportedProtocol: plugin.supportedProtocol,
      });
    }
    if ("supportedProtocol" in normalized.plugin) {
      const plugin = normalized.plugin;
      return Object.freeze({
        name: plugin.name,
        profiles: plugin.profiles,
        supportedProtocol: plugin.supportedProtocol,
      });
    }

    return createNodeStoragePluginFacade(
      normalized.plugin,
      context ??
        (() => {
          const environment: Record<string, string> = {};
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              environment[key] = value;
            }
          }
          return createNodeStorageContext({ environment });
        }),
    );
  };

  const disposeStorage = (): Promise<void> => {
    if (disposePromise !== undefined) {
      return disposePromise;
    }
    disposed = true;
    if (storagePromise === undefined && typeof storageInput !== "function") {
      storagePromise = materializeStorageInput<NodeStoragePlugin>(storageInput);
    }
    disposePromise = (async () => {
      const normalized =
        storagePromise === undefined
          ? undefined
          : await storagePromise.then(
              (value) => value,
              () => undefined,
            );
      await normalized?.plugin.onUnmount?.();
    })();
    return disposePromise;
  };

  const { storage: _storageInput, ...configWithoutStorage } = config;
  return {
    ...configWithoutStorage,
    disposeStorage,
    storage,
  };
};
