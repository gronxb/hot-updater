import type { ConsoleApiClient } from "./api";

export const createDefaultConsoleApiClient = (): ConsoleApiClient => ({
  createBundle: async (bundle) =>
    (await import("./api-rpc")).createBundle({ data: bundle }),
  deleteBundle: async (params) =>
    (await import("./api-rpc")).deleteBundle({ data: params }),
  getBundle: async (params) =>
    (await import("./api-rpc")).getBundle({ data: params }),
  getBundleChildCounts: async (params) =>
    (await import("./api-rpc")).getBundleChildCounts({ data: params }),
  getBundleChildren: async (params) =>
    (await import("./api-rpc")).getBundleChildren({ data: params }),
  getBundleDownloadUrl: async (params) =>
    (await import("./api-rpc")).getBundleDownloadUrl({ data: params }),
  getBundles: async (filters) =>
    (await import("./api-rpc")).getBundles({ data: filters }),
  getChannels: async () => (await import("./api-rpc")).getChannels(),
  getConfig: async () => (await import("./api-rpc")).getConfig(),
  getConfigLoaded: async () => (await import("./api-rpc")).getConfigLoaded(),
  promoteBundle: async (params) =>
    (await import("./api-rpc")).promoteBundle({ data: params }),
  updateBundle: async (params) =>
    (await import("./api-rpc")).updateBundle({ data: params }),
});
