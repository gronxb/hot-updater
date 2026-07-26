export type StorageOperationContext<
  TBindings extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  target: "node" | "worker" | "functions" | "edge";
  environment: Readonly<Record<string, string | undefined>>;
  bindings: Readonly<TBindings>;
}>;

export type StorageByteRange = Readonly<{
  start: number;
  end?: number;
}>;

export type StorageContentRange = Readonly<{
  start: number;
  end: number;
  totalLength: number;
}>;

export type StorageObjectMetadata = Readonly<{
  contentLength: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  custom?: Readonly<Record<string, string>>;
}>;

export type StorageOperationInput<TContext> = Readonly<{
  context: TContext;
  signal?: AbortSignal;
}>;

export type StoragePutInput<TContext> = StorageOperationInput<TContext> &
  Readonly<{
    key: string;
    body: Uint8Array | ReadableStream<Uint8Array>;
    contentLength: number;
    contentType?: string;
    metadata?: Readonly<Record<string, string>>;
    condition?: "create-only";
  }>;

export type StoragePutResult =
  | Readonly<{ kind: "stored"; storageUri: string }>
  | Readonly<{ kind: "already-exists"; storageUri: string }>;

export type StorageHeadInput<TContext> = StorageOperationInput<TContext> &
  Readonly<{ storageUri: string }>;

export type StorageHeadResult =
  | Readonly<{
      kind: "found";
      storageUri: string;
      metadata: StorageObjectMetadata;
    }>
  | Readonly<{ kind: "not-found" }>;

export type StorageGetInput<TContext> = StorageOperationInput<TContext> &
  Readonly<{
    storageUri: string;
    range?: StorageByteRange;
  }>;

export type StorageGetResult =
  | Readonly<{
      kind: "found";
      storageUri: string;
      body: ReadableStream<Uint8Array>;
      metadata: StorageObjectMetadata;
      range?: StorageContentRange;
    }>
  | Readonly<{ kind: "not-found" }>;

export type StorageDeleteInput<TContext> = StorageOperationInput<TContext> &
  Readonly<{ storageUri: string }>;

export type StorageDeleteResult =
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "not-found" }>;

export type StorageIssueDownloadInput<TContext> =
  StorageOperationInput<TContext> &
    Readonly<{
      storageUri: string;
      expiresInSeconds?: number;
    }>;

export type StorageIssueDownloadResult = Readonly<{
  kind: "issued";
  downloadUrl: string;
  expiresAt?: string;
}>;

export type StorageListInput<TContext> = StorageOperationInput<TContext> &
  Readonly<{
    prefix?: string;
    cursor?: string;
    limit?: number;
  }>;

export type StorageListItem = Readonly<{
  key: string;
  storageUri: string;
  metadata: StorageObjectMetadata;
}>;

export type StorageListResult = Readonly<{
  objects: readonly StorageListItem[];
  cursor?: string;
}>;

export type StoragePluginImplementation<
  TContext extends StorageOperationContext = StorageOperationContext,
> = Readonly<{
  put(input: StoragePutInput<TContext>): Promise<StoragePutResult>;
  head(input: StorageHeadInput<TContext>): Promise<StorageHeadResult>;
  get(input: StorageGetInput<TContext>): Promise<StorageGetResult>;
  delete(input: StorageDeleteInput<TContext>): Promise<StorageDeleteResult>;
  issueDownload?(
    input: StorageIssueDownloadInput<TContext>,
  ): Promise<StorageIssueDownloadResult>;
  list?(input: StorageListInput<TContext>): Promise<StorageListResult>;
  onUnmount?(): void | Promise<void>;
}>;

export type StoragePlugin<
  TContext extends StorageOperationContext = StorageOperationContext,
> = StoragePluginImplementation<TContext> &
  Readonly<{
    name: string;
    protocol: string;
  }>;
