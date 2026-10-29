import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapterWith,
  type StorageObject,
} from "@hot-updater/plugin-core";

export interface NeonStorageConfig extends Omit<
  S3ClientConfig,
  "credentials" | "endpoint" | "forcePathStyle"
> {
  /**
   * The branch's object storage endpoint, such as
   * `https://br-xxx.storage.c-5.us-east-2.aws.neon.tech`: the
   * `AWS_ENDPOINT_URL_S3` that `neon env pull` writes.
   */
  endpoint: string;
  /** The bucket on that branch. */
  bucketName: string;
  /**
   * A storage credential of the project: the `AWS_ACCESS_KEY_ID` and
   * `AWS_SECRET_ACCESS_KEY` that `neon env pull` writes.
   */
  credentials: NonNullable<S3ClientConfig["credentials"]>;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /**
   * Lifetime of the download URLs in seconds, at most seven days, the
   * SigV4 limit. @default 3600
   */
  signedUrlExpiresIn?: number;
}

type NeonStorageOperations =
  | "put"
  | "get"
  | "getDownloadUrl"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

const PROTOCOL = "neon";
/** SigV4's limit on a presigned URL. */
const MAX_SIGNED_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const DELETE_BATCH_SIZE = 1000;

const isObjectNotFoundError = (error: unknown) => {
  if (
    error instanceof Error &&
    (error.name === "NotFound" || error.name === "NoSuchKey")
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 404
  );
};

/** The endpoint's origin, or an error that names the variable to set. */
const endpointOrigin = (endpoint: string) => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      "neonStorage needs the branch's storage endpoint (AWS_ENDPOINT_URL_S3), such as https://br-xxx.storage.c-5.us-east-2.aws.neon.tech.",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `neonStorage endpoint must not include a path: pass the bucket as bucketName instead of "${url.pathname}".`,
    );
  }
  return url.origin;
};

/**
 * Bundles in a Neon Object Storage bucket, through its S3 API. Devices
 * download from presigned URLs that expire, so a private bucket works.
 */
export const neonStorage = (
  config: NeonStorageConfig,
): StorageAdapterWith<NeonStorageOperations> => {
  const {
    basePath,
    bucketName,
    endpoint,
    region,
    signedUrlExpiresIn,
    ...s3Config
  } = config;
  if (!bucketName) {
    throw new Error("neonStorage needs a bucketName.");
  }
  const expiresIn = signedUrlExpiresIn ?? 3600;
  if (
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_SIGNED_LIFETIME_SECONDS
  ) {
    throw new Error(
      `neonStorage signedUrlExpiresIn must be between 1 and ${MAX_SIGNED_LIFETIME_SECONDS} seconds (seven days).`,
    );
  }
  const client = new S3Client({
    ...s3Config,
    endpoint: endpointOrigin(endpoint),
    // Neon serves buckets at a path of the branch's host only.
    forcePathStyle: true,
    // Neon accepts a signature for any region.
    region: region ?? "us-east-1",
  });
  const normalizedBasePath = basePath?.replace(/^\/+|\/+$/g, "") ?? "";
  const getStorageKey = createStorageKeyBuilder(normalizedBasePath);

  const getListPrefix = (prefix = "") => {
    const value = [normalizedBasePath, prefix.replace(/^\/+|\/+$/g, "")]
      .filter(Boolean)
      .join("/");
    return value ? `${value}/` : "";
  };

  /**
   * The URI `put` returns for the key, or null for a key no `put` writes,
   * such as a folder marker that ends in "/".
   */
  const getListedStorageUri = (key: string) => {
    try {
      return createStorageUri({ bucket: bucketName, key, protocol: PROTOCOL });
    } catch {
      return null;
    }
  };

  const getRelativeKey = (key: string) => {
    if (!normalizedBasePath) return key;
    const basePrefix = `${normalizedBasePath}/`;
    return key.startsWith(basePrefix) ? key.slice(basePrefix.length) : key;
  };

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, PROTOCOL);
    if (parsed.bucket !== bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStorageAdapter({
    name: "neonStorage",
    protocol: PROTOCOL,
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      await new Upload({
        client,
        params: {
          Body: body,
          Bucket: bucketName,
          CacheControl: "max-age=31536000",
          ...(contentLength === undefined
            ? {}
            : { ContentLength: contentLength }),
          ContentType: contentType,
          Key: storageKey,
        },
      }).done();
      return {
        storageUri: createStorageUri({
          bucket: bucketName,
          key: storageKey,
          protocol: PROTOCOL,
        }),
      };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucketName, Key: key }),
        );
        if (!response.Body) return { response: null };
        const headers = new Headers();
        if (response.ContentType)
          headers.set("content-type", response.ContentType);
        if (response.ContentLength !== undefined) {
          headers.set("content-length", String(response.ContentLength));
        }
        return {
          response: new Response(response.Body.transformToWebStream(), {
            headers,
          }),
        };
      } catch (error) {
        if (isObjectNotFoundError(error)) return { response: null };
        throw error;
      }
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      return {
        url: await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucketName, Key: key }),
          { expiresIn },
        ),
      };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucketName, Key: key }),
        );
        return { exists: true };
      } catch (error) {
        if (isObjectNotFoundError(error)) return { exists: false };
        throw error;
      }
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await client.send(
        new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
      );
      return { deleted: true };
    },
    async listObjects(prefix) {
      const objects: StorageObject[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
            Prefix: getListPrefix(prefix),
          }),
        );
        for (const object of response.Contents ?? []) {
          if (!object.Key) continue;
          const storageUri = getListedStorageUri(object.Key);
          if (storageUri === null) continue;
          objects.push({
            key: getRelativeKey(object.Key),
            lastModifiedAt: object.LastModified,
            size: object.Size ?? 0,
            storageUri,
          });
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return objects;
    },
    async deleteObjects(relativeKeys) {
      const keys = relativeKeys.map((key) => getStorageKey(key));
      for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
        const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
        const response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (response.Errors && response.Errors.length > 0) {
          throw new Error(
            `Failed to delete ${response.Errors.length} Neon Object Storage object(s).`,
          );
        }
      }
    },
  });
};
