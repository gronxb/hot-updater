import {
  StoragePluginError,
  type StorageObjectMetadata,
} from "@hot-updater/plugin-core/storage";

export const createStorageKey = (
  basePath: string | undefined,
  key: string,
): string => {
  if (key.length === 0) {
    throw new StoragePluginError("invalid-input", "S3 storage key is empty.");
  }
  return [basePath ?? "", key].filter(Boolean).join("/");
};

export const parseS3Uri = (
  storageUri: string,
  expectedBucket: string,
): Readonly<{ key: string }> => {
  const uri = new URL(storageUri);
  const key = uri.pathname.slice(1);
  if (uri.hostname !== expectedBucket || key.length === 0) {
    throw new StoragePluginError(
      "invalid-uri",
      "S3 storage URI does not match the configured bucket.",
    );
  }
  return { key };
};

type S3MetadataOutput = Readonly<{
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  LastModified?: Date;
  Metadata?: Record<string, string>;
  ContentRange?: string;
}>;

export const metadataFromS3 = (
  output: S3MetadataOutput,
): StorageObjectMetadata => {
  const totalFromRange = output.ContentRange?.match(/^bytes \d+-\d+\/(\d+)$/);
  const contentLength =
    totalFromRange == null
      ? (output.ContentLength ?? 0)
      : Number(totalFromRange[1]);
  return {
    contentLength,
    ...(output.ContentType === undefined
      ? {}
      : { contentType: output.ContentType }),
    ...(output.ETag === undefined ? {} : { etag: output.ETag }),
    ...(output.LastModified === undefined
      ? {}
      : { lastModified: output.LastModified.toISOString() }),
    ...(output.Metadata === undefined ? {} : { custom: output.Metadata }),
  };
};

export const contentRangeFromS3 = (
  contentRange: string | undefined,
):
  | Readonly<{ start: number; end: number; totalLength: number }>
  | undefined => {
  const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (match == null) {
    return undefined;
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    totalLength: Number(match[3]),
  };
};
