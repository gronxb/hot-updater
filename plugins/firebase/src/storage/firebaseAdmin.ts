import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

import type {
  FirebaseStorageClientFactory,
  FirebaseStorageClientHandle,
} from "./types";

const toMetadata = (
  metadata: Readonly<{
    size?: number | string;
    contentType?: string;
    etag?: string;
    updated?: string;
    metadata?: Readonly<Record<string, string | boolean | number | null>>;
  }>,
) => {
  const custom = Object.fromEntries(
    Object.entries(metadata.metadata ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    contentLength: Number(metadata.size),
    ...(metadata.contentType === undefined
      ? {}
      : { contentType: metadata.contentType }),
    ...(metadata.etag === undefined ? {} : { etag: metadata.etag }),
    ...(metadata.updated === undefined
      ? {}
      : { lastModified: new Date(metadata.updated).toISOString() }),
    ...(Object.keys(custom).length === 0 ? {} : { custom }),
  };
};

const closeOwnedApp = (app: App, owned: boolean): (() => Promise<void>) => {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= owned ? deleteApp(app) : Promise.resolve();
    return closing;
  };
};

export const createFirebaseAdminClient: FirebaseStorageClientFactory = async (
  config,
  _scope,
): Promise<FirebaseStorageClientHandle> => {
  const app = initializeApp(
    config.appOptions,
    `hot-updater-storage-${randomUUID()}`,
  );
  const bucket = getStorage(app).bucket(config.storageBucket);
  const close = closeOwnedApp(app, true);

  return {
    client: {
      async put(input) {
        const file = bucket.file(input.key);
        const output = file.createWriteStream({
          resumable: false,
          metadata: {
            contentLength: input.contentLength,
            ...(input.contentType === undefined
              ? {}
              : { contentType: input.contentType }),
            ...(input.metadata === undefined
              ? {}
              : { metadata: input.metadata }),
          },
          ...(input.createOnly
            ? { preconditionOpts: { ifGenerationMatch: 0 } }
            : {}),
        });
        const source =
          input.body instanceof Uint8Array
            ? Readable.from([input.body])
            : Readable.fromWeb(input.body);
        if (input.signal === undefined) {
          await pipeline(source, output);
        } else {
          await pipeline(source, output, { signal: input.signal });
        }
      },
      async head(key) {
        const [metadata] = await bucket.file(key).getMetadata();
        return toMetadata(metadata);
      },
      async get(key, range) {
        const file = bucket.file(key);
        const [metadata] = await file.getMetadata();
        const body = Readable.toWeb(
          file.createReadStream(
            range === undefined ? {} : { start: range.start, end: range.end },
          ),
        );
        return { body, metadata: toMetadata(metadata) };
      },
      async delete(key) {
        await bucket.file(key).delete();
      },
      async issueDownload(key, expiresAtMilliseconds) {
        const [downloadUrl] = await bucket.file(key).getSignedUrl({
          action: "read",
          expires: expiresAtMilliseconds,
        });
        return downloadUrl;
      },
    },
    close,
  };
};
