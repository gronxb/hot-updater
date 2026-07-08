import type { ConsoleApiClient } from "./api-client";
import {
  createBundle,
  deleteBundle,
  getBundle,
  getBundleChildCounts,
  getBundleChildren,
  getBundleDownloadUrl,
  getBundles,
  getChannels,
  getConfig,
  getConfigLoaded,
  promoteBundle,
  updateBundle,
} from "./api-rpc";

export const defaultConsoleApiClient: ConsoleApiClient = {
  createBundle: (bundle) => createBundle({ data: bundle }),
  deleteBundle: (params) => deleteBundle({ data: params }),
  getBundle: (params) => getBundle({ data: params }),
  getBundleChildCounts: (params) => getBundleChildCounts({ data: params }),
  getBundleChildren: (params) => getBundleChildren({ data: params }),
  getBundleDownloadUrl: (params) => getBundleDownloadUrl({ data: params }),
  getBundles: (filters) => getBundles({ data: filters }),
  getChannels: () => getChannels(),
  getConfig: () => getConfig(),
  getConfigLoaded: () => getConfigLoaded(),
  promoteBundle: (params) => promoteBundle({ data: params }),
  updateBundle: (params) => updateBundle({ data: params }),
};
