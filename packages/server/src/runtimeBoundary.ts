import type {
  HotUpdaterFeatureInvocation,
  StorageOperationContext,
} from "@hot-updater/plugin-core";

import type { DatabaseAPI } from "./db/types";
import { createStorageCallContext } from "./storageAccess";
import {
  snapshotStorageContext,
  type StorageContextResolver,
  type StorageContextResolverInput,
  type StorageResolverOperation,
} from "./storageContext";
import {
  StorageInvocationAuthority,
  type StorageExecutionContext,
} from "./storageInvocation";

type BoundaryResult<TContext> = Readonly<{
  executionContext: StorageExecutionContext<TContext>;
  invocation: HotUpdaterFeatureInvocation<TContext>;
}>;

export const runStorageBoundary = <TContext, TResult>(
  authority: StorageInvocationAuthority<TContext>,
  resolver: StorageContextResolver<TContext> | undefined,
  input: StorageContextResolverInput<TContext>,
  callback: (result: BoundaryResult<TContext>) => TResult,
): TResult => {
  const token = authority.begin({
    operation: input.operation,
    platformContext: input.context,
  });
  try {
    const storageContext: StorageOperationContext | undefined =
      resolver === undefined
        ? undefined
        : snapshotStorageContext(resolver(input));
    authority.bind(token, storageContext);
    const invocation = Object.freeze({
      platformContext: input.context,
      storageToken: token,
    });
    const result = callback({
      executionContext: Object.freeze({
        ...createStorageCallContext(input.context, storageContext),
        invocation,
      }),
      invocation,
    });
    if (result instanceof Promise) {
      return result.finally(() => authority.close(token)) as TResult;
    }
    authority.close(token);
    return result;
  } catch (error) {
    authority.close(token);
    throw error;
  }
};

export const createDatabaseBoundaryApi = <TContext>(input: {
  readonly authority: StorageInvocationAuthority<TContext>;
  readonly raw: DatabaseAPI<StorageExecutionContext<TContext>>;
  readonly resolver?: StorageContextResolver<TContext>;
}): DatabaseAPI<TContext> => {
  const invoke = <TResult>(
    member: keyof DatabaseAPI<TContext>,
    context: TContext | undefined,
    callback: (
      execution: StorageExecutionContext<TContext>,
    ) => Promise<TResult>,
  ): Promise<TResult> =>
    runStorageBoundary(
      input.authority,
      input.resolver,
      {
        kind: "api",
        operation: { member, surface: "database" },
        context,
      },
      ({ executionContext }) => callback(executionContext),
    );

  const api: DatabaseAPI<TContext> = {
    async deleteBundleById(bundleId, context) {
      return invoke("deleteBundleById", context, (execution) =>
        input.raw.deleteBundleById(bundleId, execution),
      );
    },
    async getAppUpdateInfo(args, context) {
      return invoke("getAppUpdateInfo", context, (execution) =>
        input.raw.getAppUpdateInfo(args, execution),
      );
    },
    async getBundleById(id, context) {
      return invoke("getBundleById", context, (execution) =>
        input.raw.getBundleById(id, execution),
      );
    },
    async getBundles(options, context) {
      return invoke("getBundles", context, (execution) =>
        input.raw.getBundles(options, execution),
      );
    },
    async getChannels(context) {
      return invoke("getChannels", context, (execution) =>
        input.raw.getChannels(execution),
      );
    },
    async getUpdateInfo(args, context) {
      return invoke("getUpdateInfo", context, (execution) =>
        input.raw.getUpdateInfo(args, execution),
      );
    },
    async insertBundle(bundle, context) {
      return invoke("insertBundle", context, (execution) =>
        input.raw.insertBundle(bundle, execution),
      );
    },
    async insertBundles(bundles, context) {
      return invoke("insertBundles", context, (execution) =>
        input.raw.insertBundles(bundles, execution),
      );
    },
    async updateBundleById(bundleId, bundle, context) {
      return invoke("updateBundleById", context, (execution) =>
        input.raw.updateBundleById(bundleId, bundle, execution),
      );
    },
  };
  return Object.freeze(api);
};

export const featureOperation = <TContext>(
  namespace: string,
  member: string,
  invokedAlias?: string,
): StorageResolverOperation<TContext> =>
  Object.freeze({
    surface: "feature",
    namespace,
    member,
    ...(invokedAlias === undefined ? {} : { invokedAlias }),
  });

export const resolveHandlerOperation = <TContext>(
  routeId: string,
  featureRoutes: Readonly<
    Record<string, Readonly<{ namespace: string; member: string }>>
  >,
): StorageResolverOperation<TContext> | undefined => {
  const feature = featureRoutes[routeId];
  if (feature !== undefined) {
    return featureOperation<TContext>(feature.namespace, feature.member);
  }
  const member: keyof DatabaseAPI<TContext> | undefined =
    routeId === "core.update.fingerprint" ||
    routeId === "core.update.fingerprint-cohort" ||
    routeId === "core.update.app-version" ||
    routeId === "core.update.app-version-cohort"
      ? "getAppUpdateInfo"
      : routeId === "core.bundles.channels"
        ? "getChannels"
        : routeId === "core.bundles.get"
          ? "getBundleById"
          : routeId === "core.bundles.list"
            ? "getBundles"
            : routeId === "core.bundles.create"
              ? "insertBundles"
              : routeId === "core.bundles.update"
                ? "updateBundleById"
                : routeId === "core.bundles.delete"
                  ? "deleteBundleById"
                  : undefined;
  return member === undefined
    ? undefined
    : Object.freeze({ member, surface: "database" });
};
