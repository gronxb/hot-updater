import type { StorageOperationContext } from "@hot-updater/plugin-core";
import { StorageConfigurationError } from "@hot-updater/plugin-core";

import type { DatabaseAPI } from "./db/types";

export type StorageResolverOperation<TContext = undefined> =
  | Readonly<{
      surface: "database";
      member: keyof DatabaseAPI<TContext>;
    }>
  | Readonly<{
      surface: "feature";
      namespace: string;
      member: string;
      invokedAlias?: string;
    }>;

export type StorageContextResolverInput<TContext = undefined> =
  | Readonly<{
      kind: "handler";
      request: Request;
      operation: StorageResolverOperation<TContext>;
      context: TContext | undefined;
    }>
  | Readonly<{
      kind: "api";
      operation: StorageResolverOperation<TContext>;
      context: TContext | undefined;
    }>;

export type StorageContextResolver<TContext = undefined> = (
  input: StorageContextResolverInput<TContext>,
) => StorageOperationContext;

export const snapshotStorageContext = (
  context: StorageOperationContext,
): StorageOperationContext => {
  if (
    typeof context !== "object" ||
    context === null ||
    !["node", "worker", "functions", "edge"].includes(context.target) ||
    typeof context.environment !== "object" ||
    context.environment === null ||
    typeof context.bindings !== "object" ||
    context.bindings === null ||
    Object.values(context.environment).some(
      (value) => value !== undefined && typeof value !== "string",
    )
  ) {
    throw new StorageConfigurationError(
      "invalid-storage-input",
      "The storageContext resolver returned an invalid context.",
    );
  }
  return Object.freeze({
    target: context.target,
    environment: Object.freeze({ ...context.environment }),
    bindings: Object.freeze({ ...context.bindings }),
  });
};
