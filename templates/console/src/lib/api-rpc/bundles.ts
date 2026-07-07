import { createServerFn } from "@tanstack/react-start";

import {
  getStorageUriProtocol,
  isDirectDownloadStorageUri,
} from "../console-capabilities";
import { DEFAULT_PAGE_LIMIT } from "../constants";
import { withConsoleAuth } from "./auth";

type GetBundlesInput = {
  channel?: string;
  platform?: "ios" | "android";
  page?: number;
  limit?: string;
  after?: string;
  before?: string;
};

type GetBundleInput = {
  bundleId: string;
};

type GetBundleChildrenInput = {
  baseBundleId: string;
};

type GetBundleChildCountsInput = {
  bundleIds: string[];
};

type GetBundleDownloadUrlInput = {
  bundleId: string;
};

const assertRemoteDownloadUrl = (fileUrl: string) => {
  try {
    const protocol = new URL(fileUrl).protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return fileUrl;
    }
  } catch {
    // Fall through to the browser-facing error below.
  }

  throw new Error(
    "Storage plugin returned a local file path; browser downloads require an HTTP(S) download URL.",
  );
};

export const getBundles = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundlesInput | undefined) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const query = {
          channel: data?.channel ?? undefined,
          platform: data?.platform ?? undefined,
          page:
            typeof data?.page === "number" &&
            Number.isInteger(data.page) &&
            data.page > 1
              ? data.page
              : undefined,
          limit: data?.limit ? Number(data.limit) : DEFAULT_PAGE_LIMIT,
          after: data?.after ?? undefined,
          before: data?.before ?? undefined,
        };

        const { requireConsoleOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "readBundles",
        );
        const bundleQueryOptions = {
          where: {
            channel: query.channel,
            platform: query.platform,
          },
          limit: query.limit,
          page: query.page,
          cursor:
            query.after || query.before
              ? {
                  after: query.after,
                  before: query.before,
                }
              : undefined,
        } satisfies Parameters<typeof databasePlugin.getBundles>[0];
        const bundles = await databasePlugin.getBundles(bundleQueryOptions);

        return (
          bundles ?? {
            data: [],
            pagination: {
              total: 0,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 0,
            },
          }
        );
      } catch (error) {
        console.error("Error during bundle retrieval:", error);
        throw error;
      }
    }),
  );

export const getBundle = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { requireConsoleOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "readBundle",
        );
        const bundle = await databasePlugin.getBundleById(data.bundleId);
        return bundle ?? null;
      } catch (error) {
        console.error("Error during bundle retrieval:", error);
        throw error;
      }
    }),
  );

export const getBundleChildren = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildrenInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { getBundleChildren: getBundleChildrenWithConfig } =
          await import("../server/getBundleChildren");
        const { requireConsoleOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "readBundleLineage",
        );

        return await getBundleChildrenWithConfig(data, {
          databasePlugin,
        });
      } catch (error) {
        console.error("Error during bundle children retrieval:", error);
        throw error;
      }
    }),
  );

export const getBundleChildCounts = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildCountsInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { getBundleChildCounts: getBundleChildCountsWithConfig } =
          await import("../server/getBundleChildren");
        const { requireConsoleOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "readBundleLineage",
        );

        return await getBundleChildCountsWithConfig(data.bundleIds, {
          databasePlugin,
        });
      } catch (error) {
        console.error("Error during bundle child count retrieval:", error);
        throw error;
      }
    }),
  );

export const getBundleDownloadUrl = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleDownloadUrlInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        const { rejectConsoleOperation, requireConsoleOperation } =
          await import("../server/capabilities.server");
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "readBundle",
        );
        const bundle = await databasePlugin.getBundleById(data.bundleId);

        if (!bundle) {
          throw new Error("Bundle not found");
        }

        const { storageUri } = bundle;
        if (!storageUri) {
          throw new Error("Bundle has no storage URI");
        }

        if (isDirectDownloadStorageUri(storageUri)) {
          return { fileUrl: storageUri };
        }

        const protocol = getStorageUriProtocol(storageUri);
        if (!protocol) {
          throw new Error("Bundle storage URI is invalid");
        }

        if (storagePlugin.supportedProtocol !== protocol) {
          rejectConsoleOperation(
            "downloadBundle",
            `No storage plugin for protocol: ${protocol}`,
          );
        }

        const { requireRuntimeStorageOperation } =
          await import("../server/capabilities.server");
        const runtimeStoragePlugin = requireRuntimeStorageOperation(
          { databasePlugin, storagePlugin },
          "downloadBundle",
        );

        const downloadTarget =
          await runtimeStoragePlugin.profiles.runtime.getDownloadUrl(
            storageUri,
          );
        const { fileUrl } = downloadTarget;

        if (!fileUrl) {
          throw new Error("Storage plugin returned empty fileUrl");
        }

        return { fileUrl: assertRemoteDownloadUrl(fileUrl) };
      } catch (error) {
        console.error("Error during bundle download URL retrieval:", error);
        throw error;
      }
    }),
  );
