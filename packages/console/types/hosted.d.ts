import type { ConsoleApiClient, ConsoleBundle } from "./embedded";

export type Bundle = ConsoleBundle;

export type HotUpdaterConsoleServerApi = ConsoleApiClient;
export type HotUpdaterConsolePlatform = "ios" | "android";
export type HotUpdaterConsoleBundle = {
  id: string;
  platform: HotUpdaterConsolePlatform;
  shouldForceUpdate: boolean;
  enabled: boolean;
  fileHash: string;
  storageUri: string;
  gitCommitHash: string | null;
  message: string | null;
  channel: string;
  targetAppVersion: string | null;
  fingerprintHash: string | null;
  metadata?: {
    app_version?: string;
  };
  manifestStorageUri?: string | null;
  manifestFileHash?: string | null;
  assetBaseStorageUri?: string | null;
  patches?:
    | {
        baseBundleId: string;
        baseFileHash: string;
        patchFileHash: string;
        patchStorageUri: string;
      }[]
    | null;
  patchBaseBundleId?: string | null;
  patchBaseFileHash?: string | null;
  patchFileHash?: string | null;
  patchStorageUri?: string | null;
  rolloutCohortCount?: number | null;
  targetCohorts?: string[] | null;
};
export type HotUpdaterConsolePagination = {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentPage: number;
  totalPages: number;
  nextCursor?: string | null;
  previousCursor?: string | null;
};
export type HotUpdaterConsoleDatabasePlugin = {
  getChannels: (context?: unknown) => Promise<string[]>;
  getBundleById: (
    bundleId: string,
    context?: unknown,
  ) => Promise<HotUpdaterConsoleBundle | null>;
  getBundles: (
    options: {
      where?: {
        channel?: string;
        platform?: HotUpdaterConsolePlatform;
        enabled?: boolean;
        id?: {
          eq?: string;
          gt?: string;
          gte?: string;
          lt?: string;
          lte?: string;
          in?: string[];
        };
        targetAppVersion?: string | null;
        targetAppVersionIn?: string[];
        targetAppVersionNotNull?: boolean;
        fingerprintHash?: string | null;
      };
      limit: number;
      page?: number;
      cursor?: {
        after?: string;
        before?: string;
      };
      orderBy?: {
        field: "id";
        direction: "asc" | "desc";
      };
    },
    context?: unknown,
  ) => Promise<{
    data: HotUpdaterConsoleBundle[];
    pagination: HotUpdaterConsolePagination;
  }>;
  updateBundle: (
    targetBundleId: string,
    newBundle: Partial<HotUpdaterConsoleBundle>,
    context?: unknown,
  ) => Promise<void>;
  appendBundle: (
    insertBundle: HotUpdaterConsoleBundle,
    context?: unknown,
  ) => Promise<void>;
  commitBundle: (context?: unknown) => Promise<void>;
  onUnmount?: () => Promise<void>;
  name: string;
  deleteBundle: (
    deleteBundle: HotUpdaterConsoleBundle,
    context?: unknown,
  ) => Promise<void>;
};
export type HotUpdaterConsoleStoragePlugin = {
  upload?: (params: {
    readonly key: string;
    readonly source:
      | {
          readonly kind: "file";
          readonly filePath: string;
        }
      | {
          readonly kind: "bytes";
          readonly data: ArrayBuffer | Uint8Array | string;
          readonly contentType?: string;
        };
  }) => Promise<{ readonly storageUri: string }>;
  exists?: (params: { readonly storageUri: string }) => Promise<boolean>;
  delete?: (params: { readonly storageUri: string }) => Promise<void>;
  getDownloadUrl?: (params: {
    readonly storageUri: string;
  }) => Promise<{ readonly fileUrl: string }>;
  readText?: (params: {
    readonly storageUri: string;
  }) => Promise<string | null>;
  readBytes?: (params: {
    readonly storageUri: string;
  }) => Promise<ArrayBuffer | Uint8Array | null>;
  readonly supportedProtocol: string;
  readonly name: string;
};
export type HotUpdaterConsoleConfig = {
  console?: {
    gitUrl?: string;
    port?: number;
    [key: string]: unknown;
  };
  database: () =>
    | Promise<HotUpdaterConsoleDatabasePlugin>
    | HotUpdaterConsoleDatabasePlugin;
  storage: () =>
    | Promise<HotUpdaterConsoleStoragePlugin>
    | HotUpdaterConsoleStoragePlugin;
};

export declare function createHotUpdaterConsoleApi(
  config: HotUpdaterConsoleConfig,
): HotUpdaterConsoleServerApi;
