import {
  StoragePluginError,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

export type StorageConformanceAssertionName =
  | "atomic-create-only"
  | "byte-round-trip"
  | "cancellation-cancels-input-stream"
  | "exact-idempotent-delete"
  | "head-and-not-found"
  | "inclusive-range-and-metadata"
  | "optional-capabilities-omitted"
  | "stream-round-trip"
  | "unmount-is-idempotent"
  | "uri-validation";

export class StorageConformanceError extends Error {
  readonly assertion: StorageConformanceAssertionName;

  constructor(assertion: StorageConformanceAssertionName, detail: string) {
    super(`${assertion}: ${detail}`);
    this.name = "StorageConformanceError";
    this.assertion = assertion;
  }
}

export const failConformance = (
  assertion: StorageConformanceAssertionName,
  detail: string,
): never => {
  throw new StorageConformanceError(assertion, detail);
};

export const readStorageStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const storageBytesEqual = (
  left: Uint8Array,
  right: Uint8Array,
): boolean =>
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

type PutFixture<TContext extends StorageOperationContext> = Readonly<{
  plugin: StoragePlugin<TContext>;
  context: TContext;
  key: string;
  body: Uint8Array;
  assertion: StorageConformanceAssertionName;
}>;

export const putStorageFixture = async <
  TContext extends StorageOperationContext,
>(
  fixture: PutFixture<TContext>,
): Promise<string> => {
  const result = await fixture.plugin.put({
    context: fixture.context,
    key: fixture.key,
    body: fixture.body,
    contentLength: fixture.body.byteLength,
  });
  if (result.kind !== "stored") {
    return failConformance(fixture.assertion, "a fresh key was not stored");
  }
  return result.storageUri;
};

export const expectStorageErrorCode = async (
  operation: Promise<unknown>,
  code: "aborted" | "invalid-uri",
  assertion: StorageConformanceAssertionName,
): Promise<void> => {
  const outcome = await operation.then(
    () => ({ kind: "resolved" }) as const,
    (error: unknown) => ({ kind: "rejected", error }) as const,
  );
  if (
    outcome.kind !== "rejected" ||
    !(outcome.error instanceof StoragePluginError) ||
    outcome.error.code !== code
  ) {
    failConformance(
      assertion,
      `operation did not reject with StoragePluginError code ${code}`,
    );
  }
};
