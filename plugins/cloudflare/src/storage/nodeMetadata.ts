import type { StorageObjectMetadata } from "@hot-updater/plugin-core/storage";

type S3MetadataOutput = Readonly<{
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  LastModified?: Date;
  Metadata?: Record<string, string>;
  ContentRange?: string;
}>;

export const metadataFrom = (
  output: S3MetadataOutput,
): StorageObjectMetadata => {
  const totalFromRange = output.ContentRange?.match(/^bytes \d+-\d+\/(\d+)$/u);
  return {
    contentLength:
      totalFromRange === null || totalFromRange === undefined
        ? (output.ContentLength ?? 0)
        : Number(totalFromRange[1]),
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

export const rangeFrom = (
  value: string | undefined,
):
  | Readonly<{ start: number; end: number; totalLength: number }>
  | undefined => {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (match === null || match === undefined) {
    return undefined;
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    totalLength: Number(match[3]),
  };
};
