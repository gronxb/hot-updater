import {
  isNodeStoragePlugin,
  isRuntimeStoragePlugin,
  type DatabasePlugin,
  type NodeStoragePlugin,
  type RuntimeStoragePlugin,
  type StoragePlugin,
} from "@hot-updater/plugin-core";
import { setResponseStatus } from "@tanstack/react-start/server";

import {
  consoleOperationLabels,
  type ConsoleCapabilities,
  type ConsoleOperationCapability,
  type ConsoleOperationKey,
} from "../console-capabilities";

type ConsoleCapabilityDependencies = {
  readonly databasePlugin: DatabasePlugin;
  readonly storagePlugin: StoragePlugin;
};

const isFunctionProperty = (value: object, key: PropertyKey) =>
  typeof Object.getOwnPropertyDescriptor(value, key)?.value === "function";

const capability = (
  supported: boolean,
  reason: string,
): ConsoleOperationCapability => ({
  supported,
  reason: supported ? null : reason,
});

export class ConsoleCapabilityError extends Error {
  readonly code = "CONSOLE_CAPABILITY_UNSUPPORTED";
  readonly operation: ConsoleOperationKey;

  constructor(operation: ConsoleOperationKey, reason: string | null) {
    super(reason ?? `${consoleOperationLabels[operation]} is not supported.`);
    this.name = "ConsoleCapabilityError";
    this.operation = operation;
  }
}

export const rejectConsoleOperation = (
  operation: ConsoleOperationKey,
  reason: string | null,
): never => {
  setResponseStatus(409);
  throw new ConsoleCapabilityError(operation, reason);
};

export const createConsoleCapabilities = ({
  databasePlugin,
  storagePlugin,
}: ConsoleCapabilityDependencies): ConsoleCapabilities => {
  const canReadBundle = isFunctionProperty(databasePlugin, "getBundleById");
  const canReadBundles = isFunctionProperty(databasePlugin, "getBundles");
  const canReadChannels = isFunctionProperty(databasePlugin, "getChannels");
  const canUpdate = isFunctionProperty(databasePlugin, "updateBundle");
  const canAppend = isFunctionProperty(databasePlugin, "appendBundle");
  const canDelete = isFunctionProperty(databasePlugin, "deleteBundle");
  const canCommit = isFunctionProperty(databasePlugin, "commitBundle");
  const hasNodeStorage = isNodeStoragePlugin(storagePlugin);
  const hasRuntimeStorage = isRuntimeStoragePlugin(storagePlugin);
  const writeReason = `${databasePlugin.name} does not support bundle writes.`;
  const nodeReason =
    `${storagePlugin.name} does not support node storage operations for ` +
    `protocol "${storagePlugin.supportedProtocol}".`;

  return {
    readChannels: capability(
      canReadChannels,
      `${databasePlugin.name} does not support channel reads.`,
    ),
    readBundles: capability(
      canReadBundles,
      `${databasePlugin.name} does not support bundle list reads.`,
    ),
    readBundle: capability(
      canReadBundle,
      `${databasePlugin.name} does not support bundle reads.`,
    ),
    readBundleLineage: capability(
      canReadBundle && canReadBundles,
      `${databasePlugin.name} does not support bundle lineage reads.`,
    ),
    updateBundle: capability(
      canReadBundle && canUpdate && canCommit,
      writeReason,
    ),
    createBundle: capability(canAppend && canCommit, writeReason),
    promoteBundleMove: capability(
      canReadBundle && canUpdate && canCommit,
      writeReason,
    ),
    promoteBundleCopy: capability(
      canReadBundle && canAppend && canCommit && hasNodeStorage,
      hasNodeStorage ? writeReason : nodeReason,
    ),
    deleteBundle: capability(
      canReadBundle && canDelete && canCommit && hasNodeStorage,
      hasNodeStorage ? writeReason : nodeReason,
    ),
    downloadBundle: capability(
      hasRuntimeStorage,
      `${storagePlugin.name} does not support runtime download URLs.`,
    ),
  };
};

export const requireConsoleOperation = (
  dependencies: ConsoleCapabilityDependencies,
  operation: ConsoleOperationKey,
) => {
  const operationCapability =
    createConsoleCapabilities(dependencies)[operation];

  if (!operationCapability.supported) {
    rejectConsoleOperation(operation, operationCapability.reason);
  }
};

export const requireNodeStorageOperation = (
  dependencies: ConsoleCapabilityDependencies,
  operation: ConsoleOperationKey,
): NodeStoragePlugin => {
  requireConsoleOperation(dependencies, operation);
  if (!isNodeStoragePlugin(dependencies.storagePlugin)) {
    setResponseStatus(409);
    throw new ConsoleCapabilityError(operation, null);
  }

  return dependencies.storagePlugin;
};

export const requireRuntimeStorageOperation = (
  dependencies: ConsoleCapabilityDependencies,
  operation: ConsoleOperationKey,
): RuntimeStoragePlugin => {
  requireConsoleOperation(dependencies, operation);
  if (!isRuntimeStoragePlugin(dependencies.storagePlugin)) {
    setResponseStatus(409);
    throw new ConsoleCapabilityError(operation, null);
  }

  return dependencies.storagePlugin;
};
