import type {
  NormalizedRuntimeStorageInput,
  RuntimeStoragePlugin,
  StorageOperationContext,
  StoragePluginV2,
} from "@hot-updater/plugin-core";

export const MAX_STORAGE_TEXT_BYTES = 1024 * 1024;
const storageCallContextBrand = Symbol("storage-call-context");

export type RuntimeStorageEntry<TContext> =
  | NormalizedRuntimeStorageInput<TContext>
  | RuntimeStoragePlugin<TContext>
  | StoragePluginV2;

export type StorageCallContext<TContext> = Readonly<{
  readonly [storageCallContextBrand]: true;
  platformContext: TContext | undefined;
  storageContext?: StorageOperationContext;
}>;

export const createStorageCallContext = <TContext>(
  platformContext: TContext | undefined,
  storageContext: StorageOperationContext | undefined,
): StorageCallContext<TContext> =>
  Object.freeze({
    [storageCallContextBrand]: true,
    platformContext,
    ...(storageContext === undefined ? {} : { storageContext }),
  });

type RuntimeStorageRecord<TContext> =
  | Readonly<{
      kind: "legacy";
      plugin: RuntimeStoragePlugin<TContext>;
      protocol: string;
    }>
  | Readonly<{
      kind: "v2";
      plugin: StoragePluginV2;
      protocol: string;
    }>;

const isV2 = <TContext>(
  plugin: RuntimeStoragePlugin<TContext> | StoragePluginV2,
): plugin is StoragePluginV2 => "protocol" in plugin;

const unwrap = <TContext>(
  entry: RuntimeStorageEntry<TContext>,
): RuntimeStoragePlugin<TContext> | StoragePluginV2 =>
  "origin" in entry ? entry.plugin : entry;

const assertRemoteDownloadUrl = (fileUrl: string): string => {
  if (URL.canParse(fileUrl)) {
    const protocol = new URL(fileUrl).protocol.slice(0, -1);
    if (protocol === "http" || protocol === "https") return fileUrl;
  }
  throw new Error(
    "Storage plugin returned a local file path; runtime update checks require an HTTP(S) download URL.",
  );
};

const getStorageProtocol = (storageUri: string): string => {
  try {
    return new URL(storageUri).protocol.slice(0, -1);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid storage URI: ${storageUri}`);
    }
    throw error;
  }
};

const readTextStream = async (
  stream: ReadableStream<Uint8Array>,
  contentLength?: number,
): Promise<string> => {
  const reader = stream.getReader();
  if (contentLength !== undefined && contentLength > MAX_STORAGE_TEXT_BYTES) {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
    throw new Error("Storage text exceeds the maximum size.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_STORAGE_TEXT_BYTES) {
        await reader.cancel();
        throw new Error("Storage text exceeds the maximum size.");
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

export const createStorageAccess = <TContext>(
  entries: readonly RuntimeStorageEntry<TContext>[],
) => {
  const records = new Map<string, RuntimeStorageRecord<TContext>>();
  for (const entry of entries) {
    const plugin = unwrap(entry);
    const protocol = (
      isV2(plugin) ? plugin.protocol : plugin.supportedProtocol
    ).toLowerCase();
    const existing = records.get(protocol);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate storage protocol "${protocol}" from plugins "${existing.plugin.name}" and "${plugin.name}".`,
      );
    }
    records.set(
      protocol,
      isV2(plugin)
        ? { kind: "v2", plugin, protocol }
        : { kind: "legacy", plugin, protocol },
    );
  }

  const resolveFileUrl = async (
    storageUri: string | null,
    context?: TContext | StorageCallContext<TContext>,
  ): Promise<string | null> => {
    if (!storageUri) return null;
    const protocol = getStorageProtocol(storageUri);
    const record = records.get(protocol.toLowerCase());
    if (record?.kind === "legacy") {
      const platformContext =
        context !== undefined &&
        typeof context === "object" &&
        context !== null &&
        storageCallContextBrand in context
          ? context.platformContext
          : context;
      const result = await record.plugin.profiles.runtime.getDownloadUrl(
        storageUri,
        platformContext,
      );
      if (!result.fileUrl) {
        throw new Error("Storage plugin returned empty fileUrl");
      }
      return assertRemoteDownloadUrl(result.fileUrl);
    }
    if (record?.kind === "v2") {
      if (
        context === undefined ||
        typeof context !== "object" ||
        context === null ||
        !("storageContext" in context)
      ) {
        throw new Error("Storage v2 context is unavailable.");
      }
      const issueDownload = record.plugin.issueDownload;
      if (issueDownload === undefined) {
        throw new Error(
          `Storage plugin "${record.plugin.name}" cannot issue download URLs.`,
        );
      }
      const storageContext = context.storageContext;
      if (storageContext === undefined) {
        throw new Error("Storage v2 context is unavailable.");
      }
      const result = await issueDownload({
        context: storageContext,
        storageUri,
      });
      return assertRemoteDownloadUrl(result.downloadUrl);
    }
    if (protocol === "http" || protocol === "https") return storageUri;
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  };

  const readStorageText = async (
    storageUri: string,
    context?: TContext | StorageCallContext<TContext>,
  ): Promise<string | null> => {
    const protocol = getStorageProtocol(storageUri);
    const record = records.get(protocol.toLowerCase());
    if (record?.kind === "legacy") {
      const platformContext =
        context !== undefined &&
        typeof context === "object" &&
        context !== null &&
        storageCallContextBrand in context
          ? context.platformContext
          : context;
      return record.plugin.profiles.runtime.readText(
        storageUri,
        platformContext,
      );
    }
    if (record?.kind === "v2") {
      if (
        context === undefined ||
        typeof context !== "object" ||
        context === null ||
        !("storageContext" in context)
      ) {
        throw new Error("Storage v2 context is unavailable.");
      }
      const storageContext = context.storageContext;
      if (storageContext === undefined) {
        throw new Error("Storage v2 context is unavailable.");
      }
      const result = await record.plugin.get({
        context: storageContext,
        storageUri,
      });
      return result.kind === "not-found"
        ? null
        : readTextStream(result.body, result.metadata.contentLength);
    }
    if (protocol === "http" || protocol === "https") {
      const response = await fetch(storageUri);
      if (!response.ok || response.body === null) return null;
      const declaredLength = response.headers.get("content-length");
      return readTextStream(
        response.body,
        declaredLength === null ? undefined : Number(declaredLength),
      );
    }
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  };

  return Object.freeze({
    records,
    readStorageText,
    resolveFileUrl,
  });
};
