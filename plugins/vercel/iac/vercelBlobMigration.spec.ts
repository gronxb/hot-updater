import { InitError } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({
  /** Each store's objects by token: pathname to body. */
  stores: new Map<string, Map<string, string>>(),
  get: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  get: blob.get,
  list: blob.list,
  put: blob.put,
}));

import { copyBlobStore, privateStoreNameFor } from "./vercelBlobMigration";

const PUBLIC_TOKEN = "vercel_blob_rw_Public1_secret";
const PRIVATE_TOKEN = "vercel_blob_rw_Private1_secret";

const objectsOf = (token: string) => {
  let objects = blob.stores.get(token);
  if (!objects) blob.stores.set(token, (objects = new Map()));
  return objects;
};

beforeEach(() => {
  vi.clearAllMocks();
  blob.stores.clear();
  // One object a page, so the copy follows the cursor.
  blob.list.mockImplementation(
    async ({ token, cursor }: { token: string; cursor?: string }) => {
      const entries = [...objectsOf(token)];
      const at = cursor === undefined ? 0 : Number(cursor);
      const page = entries.slice(at, at + 1);
      return {
        blobs: page.map(([pathname, body]) => ({
          pathname,
          size: body.length,
        })),
        hasMore: at + 1 < entries.length,
        cursor: String(at + 1),
      };
    },
  );
  blob.get.mockImplementation(
    async (pathname: string, { token }: { token: string }) => {
      const body = objectsOf(token).get(pathname);
      return body === undefined
        ? null
        : {
            statusCode: 200,
            stream: new Response(body).body,
            blob: {
              contentType: "application/octet-stream",
              size: body.length,
            },
          };
    },
  );
  blob.put.mockImplementation(
    async (
      pathname: string,
      body: ReadableStream,
      { token }: { token: string },
    ) => {
      objectsOf(token).set(pathname, await new Response(body).text());
    },
  );
});

describe("copying a public Blob store to a private one", () => {
  it("copies every object under its pathname, private, and skips what the private store holds", async () => {
    objectsOf(PUBLIC_TOKEN).set("b1/manifest.json", "{}");
    objectsOf(PUBLIC_TOKEN).set("b1/files/index.ios.bundle", "bundle");
    objectsOf(PUBLIC_TOKEN).set("b1/patches/b0!23.bsdiff", "patch");
    // What an interrupted run copied already.
    objectsOf(PRIVATE_TOKEN).set("b1/manifest.json", "{}");

    const result = await copyBlobStore({
      from: { name: "public-store", token: PUBLIC_TOKEN },
      to: { token: PRIVATE_TOKEN },
    });

    expect(result).toEqual({ copied: 2, total: 3 });
    expect(objectsOf(PRIVATE_TOKEN)).toEqual(objectsOf(PUBLIC_TOKEN));
    expect(
      blob.put.mock.calls.map(([pathname, , options]) => [pathname, options]),
    ).toEqual([
      [
        "b1/files/index.ios.bundle",
        expect.objectContaining({
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/octet-stream",
          token: PRIVATE_TOKEN,
        }),
      ],
      [
        "b1/patches/b0!23.bsdiff",
        expect.objectContaining({ access: "private" }),
      ],
    ]);
    expect(blob.get).toHaveBeenCalledWith(
      "b1/files/index.ios.bundle",
      expect.objectContaining({ access: "public", useCache: false }),
    );
    // The public store keeps its objects.
    expect(objectsOf(PUBLIC_TOKEN).size).toBe(3);

    // A rerun copies nothing.
    expect(
      await copyBlobStore({
        from: { name: "public-store", token: PUBLIC_TOKEN },
        to: { token: PRIVATE_TOKEN },
      }),
    ).toEqual({ copied: 0, total: 3 });
  });

  it("stops on an object it cannot read, and says a rerun continues", async () => {
    objectsOf(PUBLIC_TOKEN).set("b1/manifest.json", "{}");
    blob.get.mockResolvedValue(null);

    const copied = copyBlobStore({
      from: { name: "public-store", token: PUBLIC_TOKEN },
      to: { token: PRIVATE_TOKEN },
    });

    await expect(copied).rejects.toBeInstanceOf(InitError);
    await expect(copied).rejects.toThrow(
      "Could not read b1/manifest.json from Blob store public-store, so its bundles were not moved. Rerun init to continue.",
    );
  });

  it("names the private store after the public one, within Vercel's 32 characters", () => {
    expect(privateStoreNameFor("hot-updater-storage")).toBe(
      "hot-updater-storage-private",
    );
    expect(privateStoreNameFor("a".repeat(32))).toBe(
      `${"a".repeat(24)}-private`,
    );
    // Never the public store's own name.
    expect(privateStoreNameFor(`${"a".repeat(24)}-private`)).toBe(
      `${"a".repeat(23)}-private2`,
    );
  });
});
