import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll, vi } from "vitest";

import { vercelBlobStorage } from "./vercelBlobStorage";

/**
 * A Vercel Blob store behind the @vercel/blob calls the adapter makes. Like
 * the real SDK, `get` and presigned URLs put a pathname in a URL with only
 * its spaces encoded, so `#` and `?` end the path, `%` reads as an escape
 * and `\` as `/`: those pathnames miss their object. `put`, `head`, `list`
 * and `del` send the pathname intact.
 */
const { blob, objects } = vi.hoisted(() => {
  const STORE_HOST = "abc123.private.blob.vercel-storage.com";
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; contentType: string; uploadedAt: Date }
  >();
  /** The pathname the Blob CDN reads from a URL the SDK builds for `pathname`. */
  const pathnameInUrl = (pathname: string) => {
    try {
      const { pathname: path } = new URL(
        `https://${STORE_HOST}/${pathname.replaceAll(" ", "%20")}`,
      );
      return decodeURIComponent(path.slice(1));
    } catch {
      return undefined;
    }
  };
  class BlobNotFoundError extends Error {
    constructor() {
      super("Vercel Blob: The requested blob does not exist");
    }
  }
  const blob = {
    BlobNotFoundError,
    async put(
      pathname: string,
      body: ReadableStream<Uint8Array>,
      options: {
        access: string;
        addRandomSuffix: boolean;
        allowOverwrite: boolean;
        contentType: string;
        token: string;
      },
    ) {
      if (options.access !== "private") throw new Error("access mismatch");
      if (options.addRandomSuffix || !options.allowOverwrite) {
        throw new Error("The adapter must overwrite keys as they are.");
      }
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(pathname, {
        bytes,
        contentType: options.contentType,
        uploadedAt: new Date(),
      });
      return { pathname, url: `https://${STORE_HOST}/${pathname}` };
    },
    async head(pathname: string) {
      const object = objects.get(pathname);
      if (!object) throw new BlobNotFoundError();
      return { pathname, size: object.bytes.byteLength };
    },
    async get(pathname: string) {
      const read = pathnameInUrl(pathname);
      const object = read === undefined ? undefined : objects.get(read);
      if (!object) return null;
      return {
        statusCode: 200 as const,
        stream: new Response(object.bytes).body!,
        headers: new Headers({
          "content-length": String(object.bytes.byteLength),
        }),
        blob: {
          contentType: object.contentType,
          pathname: read,
          size: object.bytes.byteLength,
        },
      };
    },
    async del(pathnames: string | string[]) {
      for (const pathname of [pathnames].flat()) objects.delete(pathname);
    },
    async list({
      cursor,
      limit = 1000,
      prefix = "",
    }: {
      cursor?: string;
      limit?: number;
      prefix?: string;
    }) {
      const matching = [...objects.keys()]
        .filter((pathname) => pathname.startsWith(prefix))
        .sort();
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = matching.slice(start, start + limit);
      const hasMore = start + limit < matching.length;
      return {
        blobs: page.map((pathname) => ({
          pathname,
          size: objects.get(pathname)!.bytes.byteLength,
          uploadedAt: objects.get(pathname)!.uploadedAt,
          url: `https://${STORE_HOST}/${pathname}`,
        })),
        cursor: hasMore ? String(start + limit) : undefined,
        hasMore,
      };
    },
    async issueSignedToken({ validUntil }: { validUntil: number }) {
      return {
        clientSigningToken: "signing",
        delegationToken: "delegation",
        validUntil,
      };
    },
    async presignUrl(
      _token: unknown,
      { pathname, validUntil }: { pathname: string; validUntil: number },
    ) {
      return {
        presignedUrl: `https://${STORE_HOST}/${pathname.replaceAll(" ", "%20")}?vercel-blob-valid-until=${validUntil}`,
      };
    },
  };
  return { blob, objects };
});

vi.mock("@vercel/blob", () => blob);

/** The CDN: a presigned URL answers the object its URL path names. */
const originalFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const object = objects.get(decodeURIComponent(url.pathname.slice(1)));
    return object
      ? new Response(object.bytes, { status: 200 })
      : new Response("Not Found", { status: 404 });
  });
});
afterAll(() => {
  vi.stubGlobal("fetch", originalFetch);
});

setupStorageAdapterTestSuite({
  name: "vercelBlobStorage",
  createStorage: async () => {
    objects.clear();
    return {
      storage: vercelBlobStorage({
        basePath: "ota",
        token: "vercel_blob_rw_abc123_secret",
      }),
      basePath: "ota",
    };
  },
  fetchDownloadUrls: true,
  operations: [
    "put",
    "get",
    "getDownloadUrl",
    "exists",
    "delete",
    "listObjects",
    "deleteObjects",
  ],
});
