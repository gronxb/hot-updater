import {
  isConfigReference,
  resolveConfigReference,
  type ConfigReference,
} from "@hot-updater/core/config";
import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";
import type { AppOptions } from "firebase-admin/app";

import type {
  FirebaseStorageConfig,
  ResolvedFirebaseStorageConfig,
} from "./types";

const resolveOptional = <TValue>(
  value: TValue | ConfigReference | undefined,
  context: StorageOperationContext,
): TValue | undefined =>
  value === undefined ? undefined : resolveConfigReference(value, context);

export const resolveFirebaseConfig = (
  config: FirebaseStorageConfig,
  context: StorageOperationContext,
): ResolvedFirebaseStorageConfig => {
  const storageBucket = resolveConfigReference<string>(
    config.storageBucket,
    context,
  );
  const credential = resolveOptional<AppOptions["credential"]>(
    config.credential,
    context,
  );
  const databaseAuthVariableOverride = resolveOptional<
    AppOptions["databaseAuthVariableOverride"]
  >(config.databaseAuthVariableOverride, context);
  const databaseURL = resolveOptional<AppOptions["databaseURL"]>(
    config.databaseURL,
    context,
  );
  const serviceAccountId = resolveOptional<AppOptions["serviceAccountId"]>(
    config.serviceAccountId,
    context,
  );
  const projectId = resolveOptional<AppOptions["projectId"]>(
    config.projectId,
    context,
  );
  const httpAgent = resolveOptional<AppOptions["httpAgent"]>(
    config.httpAgent,
    context,
  );
  const appOptions: AppOptions = {
    ...(credential === undefined ? {} : { credential }),
    ...(databaseAuthVariableOverride === undefined
      ? {}
      : { databaseAuthVariableOverride }),
    ...(databaseURL === undefined ? {} : { databaseURL }),
    ...(serviceAccountId === undefined ? {} : { serviceAccountId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(httpAgent === undefined ? {} : { httpAgent }),
    storageBucket,
  };
  return {
    appOptions,
    storageBucket,
    basePath: resolveOptional<string>(config.basePath, context),
  };
};

export const isLiteralFirebaseConfig = (
  config: FirebaseStorageConfig,
): boolean => Object.values(config).every((value) => !isConfigReference(value));

export const parseFirebaseObjectKey = (
  storageUri: string,
  expectedBucket: string,
): string => {
  const url = new URL(storageUri);
  const key = url.pathname.replace(/^\/+/u, "");
  if (url.hostname !== expectedBucket || key.length === 0) {
    throw new StoragePluginError(
      "invalid-uri",
      "Firebase Storage URI bucket or object key is invalid.",
    );
  }
  return key;
};

export const assertFirebaseTarget = (
  context: StorageOperationContext,
  target: "node" | "functions",
): void => {
  if (context.target !== target) {
    throw new StoragePluginError(
      "invalid-input",
      `Firebase Storage requires context.target "${target}".`,
    );
  }
};
