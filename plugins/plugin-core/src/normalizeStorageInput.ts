import type { StoragePlugin as StoragePluginV2 } from "./storage";
import type { NodeStoragePlugin, RuntimeStoragePlugin } from "./types/index";

type LegacyStoragePluginShape = Readonly<{
  name: string;
  supportedProtocol: string;
  profiles: object;
  onUnmount?(): void | Promise<void>;
}>;

type NonCallableLegacy<TLegacy extends LegacyStoragePluginShape> =
  TLegacy extends (...args: never[]) => unknown ? never : TLegacy;

export type StorageInput<
  TLegacy extends LegacyStoragePluginShape = NodeStoragePlugin,
> =
  | NonCallableLegacy<TLegacy>
  | StoragePluginV2
  | (() => NonCallableLegacy<TLegacy> | Promise<NonCallableLegacy<TLegacy>>);

export type NormalizedStorageInput<
  TLegacy extends LegacyStoragePluginShape = NodeStoragePlugin,
> = Readonly<
  | {
      origin: "direct";
      plugin: NonCallableLegacy<TLegacy> | StoragePluginV2;
    }
  | {
      origin: "factory";
      plugin: NonCallableLegacy<TLegacy>;
    }
>;

export type RuntimeStorageInput<TContext = undefined> =
  | RuntimeStoragePlugin<TContext>
  | StoragePluginV2
  | (() => RuntimeStoragePlugin<TContext>);

export type NormalizedRuntimeStorageInput<TContext = undefined> =
  NormalizedStorageInput<RuntimeStoragePlugin<TContext>>;

export type StorageConfigurationErrorCode =
  | "invalid-storage-input"
  | "v2-factory"
  | "async-server-factory"
  | "disposed"
  | "missing-storage-context"
  | "invalid-storage-invocation";

export class StorageConfigurationError extends Error {
  readonly code: StorageConfigurationErrorCode;
  declare readonly cause?: unknown;

  constructor(
    code: StorageConfigurationErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = "StorageConfigurationError";
    this.code = code;
  }
}

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const hasFunction = (value: object, key: PropertyKey): boolean =>
  typeof Reflect.get(value, key) === "function";

const isStoragePluginV2 = (value: unknown): value is StoragePluginV2 =>
  isObject(value) &&
  typeof Reflect.get(value, "name") === "string" &&
  typeof Reflect.get(value, "protocol") === "string" &&
  hasFunction(value, "put") &&
  hasFunction(value, "head") &&
  hasFunction(value, "get") &&
  hasFunction(value, "delete");

const isLegacyStoragePlugin = (
  value: unknown,
): value is LegacyStoragePluginShape =>
  isObject(value) &&
  typeof Reflect.get(value, "name") === "string" &&
  typeof Reflect.get(value, "supportedProtocol") === "string" &&
  isObject(Reflect.get(value, "profiles"));

const closeInvalidHandle = async (value: unknown): Promise<void> => {
  if (!isObject(value)) {
    return;
  }
  const onUnmount = Reflect.get(value, "onUnmount");
  if (typeof onUnmount !== "function") {
    return;
  }
  try {
    await Reflect.apply(onUnmount, value, []);
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    return;
  }
};

const observeInvalidHandleCleanup = (value: unknown): void => {
  void closeInvalidHandle(value);
};

const invalidStorageInput = (cause?: unknown): StorageConfigurationError =>
  new StorageConfigurationError(
    "invalid-storage-input",
    "Storage must be a v1 storage plugin, a v2 storage plugin, or a legacy storage factory.",
    cause === undefined ? undefined : { cause },
  );

const v2FactoryError = (): StorageConfigurationError =>
  new StorageConfigurationError(
    "v2-factory",
    "A storage factory must return a legacy plugin. Configure a v2 storage plugin directly without an extra function.",
  );

const normalizeFactoryResult = <TLegacy extends LegacyStoragePluginShape>(
  plugin: NonCallableLegacy<TLegacy>,
): NormalizedStorageInput<TLegacy> => {
  if (isStoragePluginV2(plugin)) {
    observeInvalidHandleCleanup(plugin);
    throw v2FactoryError();
  }
  if (!isLegacyStoragePlugin(plugin)) {
    throw invalidStorageInput();
  }
  return { origin: "factory", plugin };
};

export const normalizeStoragePlugin = <
  TLegacy extends LegacyStoragePluginShape,
>(
  plugin: NonCallableLegacy<TLegacy> | StoragePluginV2,
): NormalizedStorageInput<TLegacy> => {
  if (!isStoragePluginV2(plugin) && !isLegacyStoragePlugin(plugin)) {
    throw invalidStorageInput();
  }
  return { origin: "direct", plugin };
};

export const materializeStorageInput = async <
  TLegacy extends LegacyStoragePluginShape,
>(
  input: StorageInput<TLegacy>,
): Promise<NormalizedStorageInput<TLegacy>> => {
  if (typeof input !== "function") {
    return normalizeStoragePlugin(input);
  }

  let plugin: NonCallableLegacy<TLegacy>;
  try {
    plugin = await input();
  } catch (error) {
    if (error instanceof Error) {
      throw invalidStorageInput(error);
    }
    throw invalidStorageInput(error);
  }

  if (isStoragePluginV2(plugin)) {
    await closeInvalidHandle(plugin);
    throw v2FactoryError();
  }
  if (!isLegacyStoragePlugin(plugin)) {
    throw invalidStorageInput();
  }
  return { origin: "factory", plugin };
};

export const materializeStorageInputSync = <
  TLegacy extends LegacyStoragePluginShape,
>(
  input: StorageInput<TLegacy>,
): NormalizedStorageInput<TLegacy> => {
  if (typeof input !== "function") {
    return normalizeStoragePlugin(input);
  }

  let plugin: NonCallableLegacy<TLegacy> | Promise<NonCallableLegacy<TLegacy>>;
  try {
    plugin = input();
  } catch (error) {
    if (error instanceof Error) {
      throw invalidStorageInput(error);
    }
    throw invalidStorageInput(error);
  }

  if (plugin instanceof Promise) {
    plugin.then(closeInvalidHandle, () => undefined);
    throw new StorageConfigurationError(
      "async-server-factory",
      "A synchronous storage host cannot use an asynchronous storage factory.",
    );
  }
  return normalizeFactoryResult(plugin);
};

export const materializeRuntimeStorageInputSync = <TContext>(
  input: RuntimeStorageInput<TContext>,
): NormalizedRuntimeStorageInput<TContext> =>
  materializeStorageInputSync(input);
