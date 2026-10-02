import {
  assertStorageOperations,
  createBundleStorageKey,
  createStorageKeyBuilder,
  createStorageRootUriWithPath,
  createStorageUri,
  createStorageUriWithRelativePath,
  getBundleArchiveStorageUri,
  getContentAddressedAssetStoragePath,
  type ParsedStorageUri,
  parseStorageDownloadPath,
  parseStorageUri,
  type StorageObject,
  type StorageOperation,
  type StorageAdapter,
  type StorageAdapterWith,
} from "@hot-updater/plugin-core";
import { expect } from "vitest";

export interface StorageAdapterTestContext {
  readonly storage: StorageAdapter;
  /** The base path the adapter was created with, when the suite knows it. */
  readonly basePath?: string;
  /** Whether to fetch `http(s)` download URLs and require the object's bytes. */
  readonly fetchDownloadUrls?: boolean;
}

export interface StorageAdapterTestCase {
  readonly title: string;
  /** The operations the case needs besides `put` and `get`. */
  readonly operations: readonly StorageOperation[];
  readonly run: (context: StorageAdapterTestContext) => Promise<void>;
}

const BUNDLE_ID = "0199a0c3-6f6e-7c3a-9a3e-1b2c3d4e5f60";
const ASSET_HASH =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
/** `sha256/9f/<hash>.png`: where deploy keeps a shared asset below `assets/`. */
const ASSET_PATH = getContentAddressedAssetStoragePath({
  assetPath: "assets/logo.png",
  fileHash: ASSET_HASH,
});
const MANIFEST_KEY = createBundleStorageKey(BUNDLE_ID, "manifest.json");
const ARCHIVE_KEY = createBundleStorageKey(BUNDLE_ID, "bundle.tar.br");
const ASSET_KEY = `assets/${ASSET_PATH}`;
const UNICODE_FOLDER = "unicode/한글 폴더";
const UNICODE_KEY = `${UNICODE_FOLDER}/ünïcödé 😀.txt`;
/** Keys whose URIs encode spaces, `#`, `%`, `@`, `+`, and Unicode. */
const SPECIAL_KEYS = [
  "with space/file name.txt",
  "hash#1/100%.txt",
  "symbols/logo@2x+dark.png",
  UNICODE_KEY,
];
/** How far a listed modification time may be from its put. */
const CLOCK_SKEW_MS = 15 * 60 * 1000;

const encode = (text: string) => new TextEncoder().encode(text);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Deterministic bytes, so a reordered or dropped chunk shows up. */
const patternBytes = (length: number, seed: number) => {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state;
  }
  return bytes;
};

/**
 * A one-shot body that hands out a chunk only when its reader asks for one,
 * so `read()` tells whether the adapter read all of it.
 */
const bodyOf = (bytes: Uint8Array, chunkSize = 16 * 1024) => {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, read: () => offset === bytes.byteLength };
};

/** A body that fails after its first chunk, like a file removed mid-upload. */
const failingBody = (chunk: Uint8Array) => {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) {
          controller.error(new Error("The upload source failed."));
          return;
        }
        sent = true;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
};

/** The bucket and base path of a URI `put` returned for `key`. */
const locate = (
  storage: StorageAdapter,
  storageUri: string,
  key: string,
  basePath: string | undefined,
) => {
  let parsed: ParsedStorageUri;
  try {
    parsed = parseStorageUri(storageUri, storage.protocol);
  } catch (error) {
    throw new Error(
      `put("${key}") returned "${storageUri}", which is not a canonical ${storage.protocol} storage URI: ${messageOf(error)}`,
    );
  }
  if (basePath !== undefined) {
    const expected = createStorageKeyBuilder(basePath)(key);
    expect(
      parsed.key,
      `put("${key}") returned "${storageUri}"; below base path "${basePath}" its key is "${expected}"`,
    ).toBe(expected);
  }
  if (parsed.key === key) return { bucket: parsed.bucket, prefix: "" };
  if (parsed.key.endsWith(`/${key}`)) {
    return {
      bucket: parsed.bucket,
      prefix: parsed.key.slice(0, -key.length - 1),
    };
  }
  throw new Error(
    `put("${key}") returned "${storageUri}", whose key does not end with "${key}". Deploy derives the URIs of other objects from it.`,
  );
};

interface PutOptions {
  /** Passes `contentLength`, as deploy does (the default). */
  readonly knownLength?: boolean;
  readonly chunkSize?: number;
}

/**
 * Puts objects the way deploy does and checks each URI `put` returns: a
 * canonical URI of the key, in the same bucket and below the same base path
 * as every other object.
 */
const objectsOf = (
  storage: StorageAdapterWith<"put">,
  basePath: string | undefined,
) => {
  let root: { readonly bucket: string; readonly prefix: string } | undefined;
  return {
    async put(
      key: string,
      bytes: Uint8Array,
      { knownLength = true, chunkSize }: PutOptions = {},
    ) {
      const body = bodyOf(bytes, chunkSize);
      const { storageUri } = await storage.put({
        key,
        body: body.stream,
        ...(knownLength ? { contentLength: bytes.byteLength } : {}),
        contentType: "application/octet-stream",
      });
      expect(
        body.read(),
        `put("${key}") resolved before it read the whole body`,
      ).toBe(true);
      const location = locate(storage, storageUri, key, basePath);
      root ??= location;
      expect(
        location,
        `put("${key}") returned "${storageUri}", outside the bucket or base path of the objects before it`,
      ).toEqual(root);
      return storageUri;
    },
    /** The URI `put` returns for `key`, which the case has not put. */
    uriOf(key: string) {
      if (root === undefined) {
        throw new Error("Put an object before deriving another one's URI.");
      }
      return createStorageUri({
        protocol: storage.protocol,
        bucket: root.bucket,
        key: createStorageKeyBuilder(root.prefix)(key),
      });
    },
  };
};

/** The object's bytes through `get`, or null when `get` finds none. */
const readObject = async (
  storage: StorageAdapterWith<"get">,
  storageUri: string,
) => {
  const { response } = await storage.get({ storageUri });
  if (response === null) return null;
  expect(
    response,
    `get("${storageUri}") returned no Web Response`,
  ).toBeInstanceOf(Response);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `get("${storageUri}") returned a response whose body could not be read: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    expect(
      Number(contentLength),
      `get("${storageUri}") sent a content-length other than the object's size`,
    ).toBe(bytes.byteLength);
  }
  return bytes;
};

const expectBytes = (
  actual: Uint8Array | null,
  expected: Uint8Array,
  label: string,
) => {
  expect(actual, `${label} found no object`).not.toBeNull();
  expect(actual!.byteLength, `${label} returned a body of the wrong size`).toBe(
    expected.byteLength,
  );
  expect(
    actual!.findIndex((byte, index) => byte !== expected[index]),
    `${label} returned other bytes; first difference at index`,
  ).toBe(-1);
};

const expectObject = async (
  storage: StorageAdapterWith<"get">,
  storageUri: string,
  bytes: Uint8Array,
) => {
  expectBytes(
    await readObject(storage, storageUri),
    bytes,
    `get("${storageUri}")`,
  );
  if (storage.exists) {
    expect(
      await storage.exists({ storageUri }),
      `exists("${storageUri}")`,
    ).toEqual({ exists: true });
  }
};

const expectMissing = async (
  storage: StorageAdapterWith<"get">,
  storageUri: string,
) => {
  expect(
    (await storage.get({ storageUri })).response,
    `get("${storageUri}") of a missing object`,
  ).toBeNull();
  if (storage.exists) {
    expect(
      (await storage.exists({ storageUri })).exists,
      `exists("${storageUri}") of a missing object`,
    ).toBe(false);
  }
};

/** Expects a rejected promise: not a result, and not a synchronous throw. */
const expectRejection = async (
  label: string,
  operation: () => Promise<unknown>,
) => {
  let pending: Promise<unknown>;
  try {
    pending = operation();
  } catch (error) {
    throw new Error(
      `${label} threw instead of returning a rejected promise: ${messageOf(error)}`,
    );
  }
  const outcome = await Promise.resolve(pending).then(
    () => "resolved",
    () => "rejected",
  );
  expect(outcome, label).toBe("rejected");
};

/** Every operation the adapter has that takes a storage URI rejects it. */
const expectRejectedUri = async (
  storage: StorageAdapter,
  storageUri: string,
  owner: string,
) => {
  const calls = {
    get: storage.get && (() => storage.get!({ storageUri })),
    exists: storage.exists && (() => storage.exists!({ storageUri })),
    delete: storage.delete && (() => storage.delete!({ storageUri })),
    getDownloadUrl:
      storage.getDownloadUrl && (() => storage.getDownloadUrl!({ storageUri })),
  };
  for (const [operation, call] of Object.entries(calls)) {
    if (call === undefined) continue;
    await expectRejection(`${operation}("${storageUri}") of ${owner}`, call);
  }
};

const byKey = (left: { key: string }, right: { key: string }) =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0;

interface StoredObject {
  readonly key: string;
  readonly storageUri: string;
  readonly size: number;
}

const expectListing = (
  label: string,
  listed: readonly StorageObject[],
  expected: readonly StoredObject[],
  putWindow: { readonly from: number; readonly to: number },
) => {
  expect(
    listed
      .map(({ key, storageUri, size }) => ({ key, storageUri, size }))
      .sort(byKey),
    label,
  ).toEqual([...expected].sort(byKey));
  for (const { key, lastModifiedAt } of listed) {
    if (lastModifiedAt === undefined) continue;
    expect(
      lastModifiedAt,
      `${label}: lastModifiedAt of "${key}"`,
    ).toBeInstanceOf(Date);
    const time = lastModifiedAt.getTime();
    // storage prune keeps objects modified within its protection window.
    expect(
      time >= putWindow.from - CLOCK_SKEW_MS &&
        time <= putWindow.to + CLOCK_SKEW_MS,
      `${label}: "${key}" has lastModifiedAt ${String(lastModifiedAt)}, not the time it was put`,
    ).toBe(true);
  }
};

const OPERATIONS = [
  "put",
  "get",
  "getDownloadUrl",
  "exists",
  "delete",
  "listObjects",
  "deleteObjects",
] as const satisfies readonly StorageOperation[];

const describeArgument = (value: unknown) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const { key, storageUri } = value as {
      key?: unknown;
      storageUri?: unknown;
    };
    return JSON.stringify(storageUri ?? key);
  }
  return value === undefined ? "" : JSON.stringify(value);
};

/**
 * The adapter with each rejection naming its call, such as
 * `delete("s3://bucket/key") rejected: ...`. A synchronous throw stays one.
 */
const namingCalls = (storage: StorageAdapter): StorageAdapter => {
  const named: Record<string, unknown> = {
    name: storage.name,
    protocol: storage.protocol,
  };
  for (const operation of OPERATIONS) {
    const call = storage[operation] as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    if (typeof call !== "function") continue;
    named[operation] = (...args: unknown[]) =>
      Promise.resolve(call.apply(storage, args)).catch((error: unknown) => {
        throw new Error(
          `${operation}(${args.map(describeArgument).join(", ")}) rejected: ${messageOf(error)}`,
          { cause: error },
        );
      });
  }
  return named as unknown as StorageAdapter;
};

const storageCase = <const TOperations extends readonly StorageOperation[]>(
  title: string,
  operations: TOperations,
  run: (
    context: Omit<StorageAdapterTestContext, "storage"> & {
      readonly storage: StorageAdapterWith<"put" | "get" | TOperations[number]>;
    },
  ) => Promise<void>,
): StorageAdapterTestCase => ({
  title,
  operations,
  run: async ({ storage, ...context }) => {
    assertStorageOperations(storage, ["put", "get", ...operations]);
    await run({
      ...context,
      storage: namingCalls(storage) as StorageAdapterWith<
        "put" | "get" | TOperations[number]
      >,
    });
  },
});

/**
 * The storage adapter contract, from what its consumers rely on: deploy and
 * patch (`put`, `get`, `exists`, `delete`), the Console, the server's update
 * responses and signed downloads (`get`, `getDownloadUrl`), and
 * `storage prune` (`listObjects`, `deleteObjects`).
 */
export const storageAdapterTestCases: readonly StorageAdapterTestCase[] = [
  storageCase(
    "names the adapter and its URI protocol",
    [],
    async ({ storage }) => {
      expect(typeof storage.name, "name").toBe("string");
      expect(storage.name.length, "name length").toBeGreaterThan(0);
      // The protocol createStorageUri and parseStorageUri accept.
      expect(storage.protocol, "protocol").toMatch(/^[a-z][a-z\d+.-]*$/);
    },
  ),

  storageCase(
    "stores a streamed body and reads it back",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const bytes = patternBytes(100_003, 1);
      const storageUri = await objects.put(
        "round-trip/known-length.bin",
        bytes,
        {
          chunkSize: 4_096,
        },
      );

      expectBytes(
        await readObject(storage, storageUri),
        bytes,
        `get("${storageUri}")`,
      );
      // Each get returns a response of its own.
      expectBytes(
        await readObject(storage, storageUri),
        bytes,
        `a second get("${storageUri}")`,
      );
    },
  ),

  storageCase(
    "stores a streamed body of unknown length",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const bytes = patternBytes(20_011, 2);
      const storageUri = await objects.put(
        "round-trip/unknown-length.bin",
        bytes,
        { chunkSize: 1_000, knownLength: false },
      );

      expectBytes(
        await readObject(storage, storageUri),
        bytes,
        `get("${storageUri}")`,
      );
    },
  ),

  storageCase("stores an empty object", [], async ({ storage, basePath }) => {
    const objects = objectsOf(storage, basePath);
    const storageUri = await objects.put(
      "round-trip/empty.txt",
      new Uint8Array(),
    );

    expectBytes(
      await readObject(storage, storageUri),
      new Uint8Array(),
      `get("${storageUri}")`,
    );
  }),

  storageCase(
    "keeps concurrent puts of different keys apart",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      // Deploy uploads up to eight assets at once.
      const entries = Array.from({ length: 8 }, (_, index) => ({
        key: `concurrent/${index}.bin`,
        bytes: patternBytes(4_000 + index, 10 + index),
      }));
      const storageUris = await Promise.all(
        entries.map(({ key, bytes }) =>
          objects.put(key, bytes, { chunkSize: 512 }),
        ),
      );

      for (const [index, { bytes }] of entries.entries()) {
        expectBytes(
          await readObject(storage, storageUris[index]!),
          bytes,
          `get("${storageUris[index]}")`,
        );
      }
    },
  ),

  storageCase(
    "returns the canonical URI of each key below the base path",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      for (const key of [
        MANIFEST_KEY,
        ASSET_KEY,
        "nested/one/two/three/deep.txt",
        ...SPECIAL_KEYS,
      ]) {
        const bytes = encode(`object at ${key}`);
        const storageUri = await objects.put(key, bytes);

        expectBytes(
          await readObject(storage, storageUri),
          bytes,
          `get("${storageUri}")`,
        );
      }
    },
  ),

  storageCase(
    "reads objects at the URIs deploy derives from a manifest's URI",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const archive = patternBytes(3_001, 3);
      const asset = patternBytes(1_234, 4);
      const manifestUri = await objects.put(
        MANIFEST_KEY,
        encode(JSON.stringify({ bundleId: BUNDLE_ID, assets: {} })),
      );
      const archiveUri = await objects.put(ARCHIVE_KEY, archive);
      const assetUri = await objects.put(ASSET_KEY, asset);

      const derivedArchiveUri = getBundleArchiveStorageUri({
        manifestStorageUri: manifestUri,
        bundleId: BUNDLE_ID,
      });
      const derivedAssetUri = createStorageUriWithRelativePath({
        baseStorageUri: createStorageRootUriWithPath(
          manifestUri,
          BUNDLE_ID,
          "assets",
        ),
        relativePath: ASSET_PATH,
      });
      expect(
        derivedArchiveUri,
        "the archive URI derived from the manifest's",
      ).toBe(archiveUri);
      expect(derivedAssetUri, "the asset URI derived from the manifest's").toBe(
        assetUri,
      );
      await expectObject(storage, derivedArchiveUri, archive);
      await expectObject(storage, derivedAssetUri, asset);
    },
  ),

  storageCase(
    "replaces an object put again under the same key",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const key = "overwrite/object.txt";
      const storageUri = await objects.put(key, encode("first"));

      expect(await objects.put(key, encode("second")), "a second put").toBe(
        storageUri,
      );
      expectBytes(
        await readObject(storage, storageUri),
        encode("second"),
        `get("${storageUri}")`,
      );

      // Deploys that share an asset can put its key at the same time.
      expect(
        await Promise.all([
          objects.put(key, encode("shared")),
          objects.put(key, encode("shared")),
        ]),
        "concurrent puts of one key",
      ).toEqual([storageUri, storageUri]);
      expectBytes(
        await readObject(storage, storageUri),
        encode("shared"),
        `get("${storageUri}")`,
      );
    },
  ),

  storageCase(
    "rejects a put whose body fails and keeps no object",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      await objects.put("failed-put/other.txt", encode("other"));
      const key = "failed-put/object.bin";

      await expectRejection(`put("${key}") of a body that fails`, () =>
        storage.put({
          key,
          body: failingBody(patternBytes(4_000, 5)),
          contentLength: 10_000,
          contentType: "application/octet-stream",
        }),
      );
      // Deploy skips an asset that exists, so a partial object would stay.
      await expectMissing(storage, objects.uriOf(key));
    },
  ),

  storageCase(
    "returns a null response for a missing object",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      await objects.put("missing/object.txt", encode("present"));

      // A key next to the object, one it starts with, one that starts with
      // it, and its folder.
      for (const key of [
        "missing/absent.txt",
        "missing/object.tx",
        "missing/object.txt.bak",
        "missing",
      ]) {
        const storageUri = objects.uriOf(key);
        expect(
          await storage.get({ storageUri }),
          `get("${storageUri}") of a missing object`,
        ).toEqual({ response: null });
      }
    },
  ),

  storageCase(
    "tells whether an object exists",
    ["exists"],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const storageUri = await objects.put(
        "exists/object.txt",
        encode("present"),
      );

      expect(
        await storage.exists({ storageUri }),
        `exists("${storageUri}")`,
      ).toEqual({ exists: true });
      for (const key of ["exists/absent.txt", "exists/object.tx", "exists"]) {
        const missingUri = objects.uriOf(key);
        expect(
          await storage.exists({ storageUri: missingUri }),
          `exists("${missingUri}")`,
        ).toEqual({ exists: false });
      }
    },
  ),

  storageCase(
    "deletes exactly one object, and deleting it again succeeds",
    ["delete"],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const storageUri = await objects.put("delete/object.txt", encode("gone"));
      const sibling = encode("kept");
      const siblingUri = await objects.put("delete/object.txt.bak", sibling);
      const child = encode("kept child");
      const childUri = await objects.put("delete/object/child.txt", child);

      expect(
        await storage.delete({ storageUri }),
        `delete("${storageUri}")`,
      ).toEqual({ deleted: true });
      await expectMissing(storage, storageUri);
      expect(
        await storage.delete({ storageUri }),
        `a second delete("${storageUri}")`,
      ).toEqual({ deleted: true });
      for (const key of ["delete/never-stored.txt", "delete/object"]) {
        const missingUri = objects.uriOf(key);
        expect(
          await storage.delete({ storageUri: missingUri }),
          `delete("${missingUri}")`,
        ).toEqual({ deleted: true });
      }
      // Deleting a folder's URI deletes nothing in it.
      await expectObject(storage, siblingUri, sibling);
      await expectObject(storage, childUri, child);
    },
  ),

  storageCase(
    "rejects the URI of an object in another bucket",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const bytes = encode("kept");
      const storageUri = await objects.put("foreign/object.txt", bytes);
      const { bucket, key } = parseStorageUri(storageUri, storage.protocol);

      await expectRejectedUri(
        storage,
        createStorageUri({
          protocol: storage.protocol,
          bucket: `${bucket}-other`,
          key,
        }),
        "another bucket",
      );
      // A delete that ignored the bucket would have removed this object.
      await expectObject(storage, storageUri, bytes);
    },
  ),

  storageCase(
    "rejects the URI of another protocol",
    [],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const bytes = encode("kept");
      const storageUri = await objects.put("foreign/object.txt", bytes);
      const { bucket, key } = parseStorageUri(storageUri, storage.protocol);

      await expectRejectedUri(
        storage,
        createStorageUri({ protocol: `not-${storage.protocol}`, bucket, key }),
        "another protocol",
      );
      await expectObject(storage, storageUri, bytes);
    },
  ),

  storageCase(
    "resolves a download URL for a stored object",
    ["getDownloadUrl"],
    async ({ storage, basePath, fetchDownloadUrls }) => {
      const objects = objectsOf(storage, basePath);
      for (const key of ["download/object.txt", ...SPECIAL_KEYS]) {
        const bytes = encode(key);
        const storageUri = await objects.put(key, bytes);
        const { url } = await storage.getDownloadUrl({ storageUri });
        const label = `getDownloadUrl("${storageUri}") returned "${url}"`;

        expect(typeof url, label).toBe("string");
        if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
          expect(
            ["http:", "https:"],
            `${label}; a URL must use http(s)`,
          ).toContain(new URL(url).protocol);
          if (fetchDownloadUrls) {
            const response = await fetch(url);
            expect(response.status, `${label}, which answered`).toBe(200);
            expectBytes(
              new Uint8Array(await response.arrayBuffer()),
              bytes,
              `${label}, whose download`,
            );
          }
          continue;
        }
        // The server's client handler serves /storage/<uri>/<signature>.
        expect(
          parseStorageDownloadPath(url)?.storageUri,
          `${label}; a path must be the /storage/ path of the same URI`,
        ).toBe(storageUri);
        // The handler signs the requested URI again and compares the paths.
        expect(
          (await storage.getDownloadUrl({ storageUri })).url,
          `${label}, then another path`,
        ).toBe(url);
      }
    },
  ),

  storageCase(
    "lists every object with its key relative to the base path",
    ["listObjects"],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const entries: [string, Uint8Array][] = [
        [MANIFEST_KEY, encode("{}")],
        [ARCHIVE_KEY, patternBytes(3_001, 6)],
        [ASSET_KEY, patternBytes(1_234, 7)],
        ["bundles-other/object.txt", encode("next to bundles/")],
        ...SPECIAL_KEYS.map((key): [string, Uint8Array] => [key, encode(key)]),
      ];
      const from = Date.now();
      const stored: StoredObject[] = [];
      for (const [key, bytes] of entries) {
        stored.push({
          key,
          storageUri: await objects.put(key, bytes),
          size: bytes.byteLength,
        });
      }
      const putWindow = { from, to: Date.now() };
      const below = (folder: string) =>
        stored.filter(({ key }) => key.startsWith(`${folder}/`));

      expectListing(
        "listObjects()",
        await storage.listObjects(),
        stored,
        putWindow,
      );
      // A prefix is a folder: "bundles" lists nothing in "bundles-other/".
      expectListing(
        'listObjects("bundles")',
        await storage.listObjects("bundles"),
        below("bundles"),
        putWindow,
      );
      expectListing(
        `listObjects("${UNICODE_FOLDER}")`,
        await storage.listObjects(UNICODE_FOLDER),
        below(UNICODE_FOLDER),
        putWindow,
      );
    },
  ),

  storageCase(
    "deletes exactly the keys it receives",
    ["deleteObjects"],
    async ({ storage, basePath }) => {
      const objects = objectsOf(storage, basePath);
      const put = async (key: string) => {
        const bytes = encode(key);
        return { key, bytes, storageUri: await objects.put(key, bytes) };
      };
      const removed = [
        await put("delete-objects/object.txt"),
        await put(`delete-objects/${UNICODE_KEY}`),
      ];
      const kept = [
        await put("delete-objects/object.txt.bak"),
        await put("delete-objects/folder/child.txt"),
      ];

      await storage.deleteObjects([]);
      for (const object of [...removed, ...kept]) {
        await expectObject(storage, object.storageUri, object.bytes);
      }

      // A missing key and a folder's key delete nothing.
      await storage.deleteObjects([
        ...removed.map(({ key }) => key),
        "delete-objects/never-stored.txt",
        "delete-objects/folder",
      ]);
      for (const object of removed) {
        await expectMissing(storage, object.storageUri);
      }
      for (const object of kept) {
        await expectObject(storage, object.storageUri, object.bytes);
      }
      if (storage.listObjects) {
        expect(
          (await storage.listObjects()).map(({ key }) => key).sort(),
          "listObjects() after deleteObjects",
        ).toEqual(kept.map(({ key }) => key).sort());
      }
    },
  ),
];
