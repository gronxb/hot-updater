import { promoteBundle as promoteBundleWithConfig } from "@hot-updater/cli-tools";
import {
  isRuntimeStoragePlugin,
  type Bundle,
  type DatabaseBundleQueryOptions,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";

import { DEFAULT_PAGE_LIMIT } from "../constants";
import { isConfigLoaded, prepareConfig } from "./config.server";
import { deleteBundle as deleteBundleWithStorage } from "./deleteBundle";
import {
  getBundleChildCounts as getBundleChildCountsWithConfig,
  getBundleChildren as getBundleChildrenWithConfig,
} from "./getBundleChildren";
import { getHostedConsoleInfo } from "./hosted-context.server";

export type GetBundlesInput = {
  readonly channel?: string;
  readonly platform?: "ios" | "android";
  readonly page?: number;
  readonly limit?: string;
  readonly after?: string;
  readonly before?: string;
};

export type GetBundleInput = {
  readonly bundleId: string;
};

export type GetBundleChildrenInput = {
  readonly baseBundleId: string;
};

export type GetBundleChildCountsInput = {
  readonly bundleIds: readonly string[];
};

export type GetBundleDownloadUrlInput = {
  readonly bundleId: string;
};

export type UpdateBundleInput = {
  readonly bundleId: string;
  readonly bundle: Partial<Bundle>;
};

export type PromoteBundleInput = {
  readonly action: "copy" | "move";
  readonly bundleId: string;
  readonly nextBundleId?: string;
  readonly targetChannel: string;
};

export type DeleteBundleInput = {
  readonly bundleId: string;
};

class ConsoleOperationError extends Error {
  readonly name = "ConsoleOperationError";
}

const emptyBundleList = {
  data: [],
  pagination: {
    total: 0,
    hasNextPage: false,
    hasPreviousPage: false,
    currentPage: 1,
    totalPages: 0,
  },
} satisfies Awaited<ReturnType<DatabasePlugin["getBundles"]>>;

const assertRemoteDownloadUrl = (fileUrl: string) => {
  try {
    const protocol = new URL(fileUrl).protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return fileUrl;
    }
  } catch {
    throw new ConsoleOperationError(
      "Storage plugin returned an invalid download URL.",
    );
  }

  throw new ConsoleOperationError(
    "Storage plugin returned a local file path; browser downloads require an HTTP(S) download URL.",
  );
};

const getTelemetryKeyCapabilities = (databasePlugin: DatabasePlugin) => {
  const getTelemetryKeyState = databasePlugin.getTelemetryKeyState;
  const issueTelemetryKey = databasePlugin.issueTelemetryKey;
  const rotateTelemetryKey = databasePlugin.rotateTelemetryKey;

  if (!getTelemetryKeyState || !issueTelemetryKey || !rotateTelemetryKey) {
    return null;
  }

  return {
    getTelemetryKeyState,
    issueTelemetryKey,
    rotateTelemetryKey,
  };
};

const requireTelemetryKeyCapabilities = (databasePlugin: DatabasePlugin) => {
  const capabilities = getTelemetryKeyCapabilities(databasePlugin);

  if (!capabilities) {
    throw new ConsoleOperationError(
      "Telemetry key is not supported by this provider.",
    );
  }

  return capabilities;
};

const toBundleQueryOptions = (
  input: GetBundlesInput | undefined,
): DatabaseBundleQueryOptions => {
  const page =
    typeof input?.page === "number" &&
    Number.isInteger(input.page) &&
    input.page > 1
      ? input.page
      : undefined;
  const cursor =
    input?.after || input?.before
      ? {
          ...(input.after ? { after: input.after } : {}),
          ...(input.before ? { before: input.before } : {}),
        }
      : undefined;
  const where = {
    ...(input?.channel ? { channel: input.channel } : {}),
    ...(input?.platform ? { platform: input.platform } : {}),
  };

  return {
    where,
    limit: input?.limit ? Number(input.limit) : DEFAULT_PAGE_LIMIT,
    ...(page === undefined ? {} : { page }),
    ...(cursor === undefined ? {} : { cursor }),
  };
};

export const getConfigOperation = async () => {
  const { config, databasePlugin } = await prepareConfig();
  return {
    capabilities: {
      telemetry:
        typeof databasePlugin.authenticateTelemetryKey === "function" &&
        typeof databasePlugin.recordLifecycleEvent === "function",
      telemetryKey: Boolean(getTelemetryKeyCapabilities(databasePlugin)),
    },
    console: config.console,
    hosted: getHostedConsoleInfo(),
  };
};

export const getChannelsOperation = async () => {
  const { databasePlugin } = await prepareConfig();
  return (await databasePlugin.getChannels()) ?? [];
};

export const getConfigLoadedOperation = async () => ({
  configLoaded: isConfigLoaded(),
});

export const getTelemetryKeyStateOperation = async () => {
  const { databasePlugin } = await prepareConfig();
  const { getTelemetryKeyState } =
    requireTelemetryKeyCapabilities(databasePlugin);
  return (await getTelemetryKeyState()) ?? null;
};

export const issueTelemetryKeyOperation = async () => {
  const { databasePlugin } = await prepareConfig();
  const { issueTelemetryKey } = requireTelemetryKeyCapabilities(databasePlugin);
  return await issueTelemetryKey();
};

export const rotateTelemetryKeyOperation = async () => {
  const { databasePlugin } = await prepareConfig();
  const { rotateTelemetryKey } =
    requireTelemetryKeyCapabilities(databasePlugin);
  return await rotateTelemetryKey();
};

export const getBundlesOperation = async (input?: GetBundlesInput) => {
  const { databasePlugin } = await prepareConfig();
  return (
    (await databasePlugin.getBundles(toBundleQueryOptions(input))) ??
    emptyBundleList
  );
};

export const getBundleOperation = async ({ bundleId }: GetBundleInput) => {
  const { databasePlugin } = await prepareConfig();
  return (await databasePlugin.getBundleById(bundleId)) ?? null;
};

export const getBundleChildrenOperation = async (
  input: GetBundleChildrenInput,
) => {
  const { databasePlugin } = await prepareConfig();
  return await getBundleChildrenWithConfig(input, { databasePlugin });
};

export const getBundleChildCountsOperation = async ({
  bundleIds,
}: GetBundleChildCountsInput) => {
  const { databasePlugin } = await prepareConfig();
  return await getBundleChildCountsWithConfig([...bundleIds], {
    databasePlugin,
  });
};

export const getBundleDownloadUrlOperation = async ({
  bundleId,
}: GetBundleDownloadUrlInput) => {
  const { databasePlugin, storagePlugin } = await prepareConfig();
  const bundle = await databasePlugin.getBundleById(bundleId);

  if (!bundle) {
    throw new ConsoleOperationError("Bundle not found");
  }

  const { storageUri } = bundle;
  if (!storageUri) {
    throw new ConsoleOperationError("Bundle has no storage URI");
  }

  const url = new URL(storageUri);
  const protocol = url.protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return { fileUrl: storageUri };
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new ConsoleOperationError(
      `No storage plugin for protocol: ${protocol}`,
    );
  }

  if (!isRuntimeStoragePlugin(storagePlugin)) {
    throw new ConsoleOperationError(
      `${storagePlugin.name} does not support runtime download URL resolution.`,
    );
  }

  const downloadTarget =
    await storagePlugin.profiles.runtime.getDownloadUrl(storageUri);
  const { fileUrl } = downloadTarget;

  if (!fileUrl) {
    throw new ConsoleOperationError("Storage plugin returned empty fileUrl");
  }

  return { fileUrl: assertRemoteDownloadUrl(fileUrl) };
};

export const updateBundleOperation = async ({
  bundle,
  bundleId,
}: UpdateBundleInput) => {
  const { databasePlugin } = await prepareConfig();
  await databasePlugin.updateBundle(bundleId, bundle);
  await databasePlugin.commitBundle();
  const updatedBundle = await databasePlugin.getBundleById(bundleId);

  if (!updatedBundle) {
    throw new ConsoleOperationError("Updated bundle not found");
  }

  return { success: true, bundle: updatedBundle };
};

export const promoteBundleOperation = async (input: PromoteBundleInput) => {
  const { config, databasePlugin, storagePlugin } = await prepareConfig();
  const bundle = await promoteBundleWithConfig(input, {
    config,
    databasePlugin,
    storagePlugin,
  });

  return { success: true, bundle };
};

export const createBundleOperation = async (bundle: Bundle) => {
  const { databasePlugin } = await prepareConfig();
  await databasePlugin.appendBundle(bundle);
  await databasePlugin.commitBundle();
  return { success: true, bundleId: bundle.id };
};

export const deleteBundleOperation = async (input: DeleteBundleInput) => {
  const { databasePlugin, storagePlugin } = await prepareConfig();
  await deleteBundleWithStorage(input, {
    databasePlugin,
    storagePlugin,
    waitForStorageCleanup: false,
  });

  return { success: true };
};
