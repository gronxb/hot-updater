import type {
  StorageOperationContext,
  StoragePlugin,
  StoragePluginImplementation,
} from "./types/storage";

export type * from "./types/storage";

export type StoragePluginErrorCode =
  | "invalid-input"
  | "invalid-uri"
  | "unsupported"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "aborted"
  | "timeout"
  | "integrity"
  | "provider";

export class StoragePluginError extends Error {
  readonly code: StoragePluginErrorCode;
  declare readonly cause?: unknown;

  constructor(
    code: StoragePluginErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = "StoragePluginError";
    this.code = code;
  }
}

export const createStoragePlugin = <
  TContext extends StorageOperationContext = StorageOperationContext,
>(
  input: Readonly<{
    name: string;
    protocol: string;
    plugin: () => StoragePluginImplementation<TContext>;
  }>,
): StoragePlugin<TContext> => {
  const implementation = input.plugin();
  return {
    ...implementation,
    name: input.name,
    protocol: input.protocol,
  };
};
