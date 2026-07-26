import type {
  ConfigReference,
  ConfigResolutionContext,
} from "@hot-updater/core/config";
import type {
  StorageByteRange,
  StorageObjectMetadata,
} from "@hot-updater/plugin-core/storage";
import type { AppOptions } from "firebase-admin/app";

type ResolvableAppOptions = {
  readonly [TKey in keyof AppOptions]: AppOptions[TKey] | ConfigReference;
};

export type FirebaseStorageConfig = Omit<
  ResolvableAppOptions,
  "storageBucket"
> &
  Readonly<{
    storageBucket: string | ConfigReference;
    basePath?: string | ConfigReference;
  }>;

export type ResolvedFirebaseStorageConfig = Readonly<{
  appOptions: AppOptions;
  storageBucket: string;
  basePath?: string;
}>;

export type FirebaseStorageClient = Readonly<{
  put(input: {
    readonly key: string;
    readonly body: Uint8Array | ReadableStream<Uint8Array>;
    readonly contentLength: number;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly createOnly: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  head(key: string): Promise<StorageObjectMetadata>;
  get(
    key: string,
    range: StorageByteRange | undefined,
  ): Promise<
    Readonly<{
      body: ReadableStream<Uint8Array>;
      metadata: StorageObjectMetadata;
    }>
  >;
  delete(key: string): Promise<void>;
  issueDownload(key: string, expiresAtMilliseconds: number): Promise<string>;
}>;

export type FirebaseStorageClientHandle = Readonly<{
  client: FirebaseStorageClient;
  close(): Promise<void>;
}>;

export type FirebaseStorageClientFactory = (
  config: ResolvedFirebaseStorageConfig,
  scope: "cached" | "operation",
) => Promise<FirebaseStorageClientHandle>;

export type FirebaseStorageContext = ConfigResolutionContext;
