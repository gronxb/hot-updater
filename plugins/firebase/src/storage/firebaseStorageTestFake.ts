import type { StorageObjectMetadata } from "@hot-updater/plugin-core/storage";

import type {
  FirebaseStorageClientFactory,
  ResolvedFirebaseStorageConfig,
} from "./types";

type StoredObject = Readonly<{
  bytes: Uint8Array;
  metadata: StorageObjectMetadata;
}>;

type FirebaseStorageFake = Readonly<{
  factory: FirebaseStorageClientFactory;
  created: ResolvedFirebaseStorageConfig[];
  scopes: Array<"cached" | "operation">;
  closed: number[];
  failNext(status: number): void;
}>;

const providerError = (status: number): Error & { code: number } =>
  Object.assign(new Error("seeded provider failure"), { code: status });

const readBody = async (
  body: Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> =>
  body instanceof Uint8Array
    ? body.slice()
    : new Uint8Array(await new Response(body).arrayBuffer());

export const createFirebaseStorageFake = (): FirebaseStorageFake => {
  const objects = new Map<string, StoredObject>();
  const created: ResolvedFirebaseStorageConfig[] = [];
  const scopes: Array<"cached" | "operation"> = [];
  const closed: number[] = [];
  let nextFailure: number | undefined;

  const takeFailure = (): void => {
    if (nextFailure === undefined) {
      return;
    }
    const status = nextFailure;
    nextFailure = undefined;
    throw providerError(status);
  };

  const factory: FirebaseStorageClientFactory = async (config, scope) => {
    const handleId = created.length;
    created.push(config);
    scopes.push(scope);
    let closedHandle = false;
    const objectKey = (key: string): string => `${config.storageBucket}/${key}`;

    return {
      client: {
        async put(input) {
          takeFailure();
          const mapKey = objectKey(input.key);
          if (input.createOnly && objects.has(mapKey)) {
            throw providerError(412);
          }
          if (input.createOnly) {
            objects.set(mapKey, {
              bytes: new Uint8Array(),
              metadata: { contentLength: input.contentLength },
            });
          }
          let bytes: Uint8Array;
          try {
            bytes = await readBody(input.body);
          } catch (error) {
            if (input.createOnly) {
              objects.delete(mapKey);
            }
            throw error;
          }
          objects.set(mapKey, {
            bytes,
            metadata: {
              contentLength: bytes.byteLength,
              ...(input.contentType === undefined
                ? {}
                : { contentType: input.contentType }),
              ...(input.metadata === undefined
                ? {}
                : { custom: input.metadata }),
              etag: `etag-${input.key}`,
              lastModified: "2026-07-27T00:00:00.000Z",
            },
          });
        },
        async head(key) {
          takeFailure();
          const object = objects.get(objectKey(key));
          if (object === undefined) {
            throw providerError(404);
          }
          return object.metadata;
        },
        async get(key, range) {
          takeFailure();
          const object = objects.get(objectKey(key));
          if (object === undefined) {
            throw providerError(404);
          }
          const start = range?.start ?? 0;
          const end = range?.end ?? object.bytes.byteLength - 1;
          const bytes = object.bytes.slice(start, end + 1);
          return {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            metadata: object.metadata,
          };
        },
        async delete(key) {
          takeFailure();
          if (!objects.delete(objectKey(key))) {
            throw providerError(404);
          }
        },
        async issueDownload(key, expiresAtMilliseconds) {
          takeFailure();
          if (!objects.has(objectKey(key))) {
            throw providerError(404);
          }
          return `https://firebase.invalid/${config.storageBucket}/${key}?expires=${expiresAtMilliseconds}`;
        },
      },
      async close() {
        if (!closedHandle) {
          closedHandle = true;
          closed.push(handleId);
        }
      },
    };
  };

  return {
    factory,
    created,
    scopes,
    closed,
    failNext(status) {
      nextFailure = status;
    },
  };
};
