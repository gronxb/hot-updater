import {
  StoragePluginError,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

export type StorageConformanceAssertionName =
  | "atomic-create-only"
  | "byte-round-trip"
  | "cancellation-cancels-input-stream"
  | "concurrent-distinct-requests"
  | "exact-idempotent-delete"
  | "head-and-not-found"
  | "historical-uri-round-trip"
  | "inclusive-range-and-metadata"
  | "large-body-bounded-backpressure"
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

export type PacedStreamMetrics = Readonly<{
  pulls: number;
  backpressureEvents: number;
  maxBufferedBytes: number;
}>;

type PullWaiter = Readonly<{
  expectedPulls: number;
  resolve: () => void;
}>;

class StreamPacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamPacingError";
  }
}

const chunkByte = (chunkIndex: number, byteIndex: number): number =>
  (chunkIndex * 31 + byteIndex) % 251;

export const createPacedStorageStream = (
  chunkCount: number,
  chunkLength: number,
): Readonly<{
  stream: ReadableStream<Uint8Array>;
  waitForPull: (expectedPulls: number) => Promise<void>;
  releaseNext: () => void;
  metrics: () => PacedStreamMetrics;
}> => {
  let pulls = 0;
  let backpressureEvents = 0;
  let bufferedBytes = 0;
  let maxBufferedBytes = 0;
  const releases: Array<() => void> = [];
  const waiters: PullWaiter[] = [];

  const notifyWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && pulls >= waiter.expectedPulls) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        bufferedBytes = 0;
        const chunkIndex = pulls;
        pulls += 1;
        backpressureEvents += 1;
        notifyWaiters();
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });

        const chunk = new Uint8Array(chunkLength);
        for (let byteIndex = 0; byteIndex < chunkLength; byteIndex += 1) {
          chunk[byteIndex] = chunkByte(chunkIndex, byteIndex);
        }
        bufferedBytes = chunk.byteLength;
        maxBufferedBytes = Math.max(maxBufferedBytes, bufferedBytes);
        controller.enqueue(chunk);
        if (pulls === chunkCount) {
          controller.close();
        }
      },
    },
    { highWaterMark: 1 },
  );

  return {
    stream,
    waitForPull(expectedPulls) {
      if (pulls >= expectedPulls) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push({ expectedPulls, resolve });
      });
    },
    releaseNext() {
      const release = releases.shift();
      if (release === undefined) {
        throw new StreamPacingError("No producer pull is waiting for release.");
      }
      release();
    },
    metrics: () => ({ pulls, backpressureEvents, maxBufferedBytes }),
  };
};

export type StreamVerification = Readonly<{
  byteLength: number;
  chunkCount: number;
  duplicateChunks: number;
}>;

export const verifyStorageChunkSequence = async (
  stream: ReadableStream<Uint8Array>,
  chunkLength: number,
): Promise<StreamVerification> => {
  const reader = stream.getReader();
  const signatures = new Set<number>();
  let byteLength = 0;
  let chunkCount = 0;
  let duplicateChunks = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    for (const value of next.value) {
      const chunkIndex = Math.floor(byteLength / chunkLength);
      const byteIndex = byteLength % chunkLength;
      if (byteIndex === 0) {
        chunkCount += 1;
        if (signatures.has(value)) {
          duplicateChunks += 1;
        }
        signatures.add(value);
      }
      if (value !== chunkByte(chunkIndex, byteIndex)) {
        failConformance(
          "large-body-bounded-backpressure",
          "large stream contained duplicated or corrupted bytes",
        );
      }
      byteLength += 1;
    }
  }
  return { byteLength, chunkCount, duplicateChunks };
};

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
