import {
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll } from "vitest";

import { standaloneStorage } from "./standaloneStorage";

const BASE_URL = "https://storage.example.com/hot-updater";

/**
 * A storage service that follows the standalone contract: it keeps objects
 * below `ota/` in bucket `updates`, answers 404 for a missing object, and
 * 400 for a URI of another bucket.
 */
const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const objectKey = createStorageKeyBuilder("ota");
/** Objects a `/list` page returns, so listing takes several pages. */
const LIST_PAGE_SIZE = 3;

const keyOf = async (request: Request) => {
  const { storageUri } = (await request.json()) as { storageUri: string };
  const { bucket, key } = parseStorageUri(storageUri, "s3");
  return bucket === "updates" ? key : null;
};

const anotherBucket = () =>
  HttpResponse.json({ message: "Another bucket" }, { status: 400 });

const server = setupServer(
  http.post(`${BASE_URL}/upload`, async ({ request }) => {
    const form = await request.formData();
    const key = objectKey(String(form.get("key")));
    const file = form.get("file") as File;
    objects.set(key, new Uint8Array(await file.arrayBuffer()));
    return HttpResponse.json({
      storageUri: createStorageUri({ protocol: "s3", bucket: "updates", key }),
    });
  }),
  http.post(`${BASE_URL}/get`, async ({ request }) => {
    const key = await keyOf(request);
    if (key === null) return anotherBucket();
    const bytes = objects.get(key);
    if (bytes === undefined) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(bytes, {
      headers: { "content-length": String(bytes.byteLength) },
    });
  }),
  http.post(`${BASE_URL}/exists`, async ({ request }) => {
    const key = await keyOf(request);
    if (key === null) return anotherBucket();
    if (!objects.has(key)) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ exists: true });
  }),
  http.delete(`${BASE_URL}/delete`, async ({ request }) => {
    const key = await keyOf(request);
    if (key === null) return anotherBucket();
    return new HttpResponse(null, { status: objects.delete(key) ? 204 : 404 });
  }),
  http.post(`${BASE_URL}/list`, async ({ request }) => {
    const { prefix, cursor } = (await request.json()) as {
      prefix?: string;
      cursor?: string;
    };
    const folder = objectKey(prefix ?? "");
    const keys = [...objects.keys()]
      .filter((key) => key.startsWith(`${folder}/`))
      .sort();
    const start = Number(cursor ?? 0);
    const end = start + LIST_PAGE_SIZE;
    return HttpResponse.json({
      objects: keys.slice(start, end).map((key) => ({
        key: key.slice("ota/".length),
        storageUri: createStorageUri({
          protocol: "s3",
          bucket: "updates",
          key,
        }),
        size: objects.get(key)!.byteLength,
      })),
      ...(end < keys.length ? { cursor: String(end) } : {}),
    });
  }),
  http.post(`${BASE_URL}/delete-objects`, async ({ request }) => {
    const { keys } = (await request.json()) as { keys: string[] };
    for (const key of keys) objects.delete(objectKey(key));
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

setupStorageAdapterTestSuite({
  name: "standaloneStorage",
  createStorage: async () => {
    objects.clear();
    return {
      storage: standaloneStorage({ baseUrl: BASE_URL, protocol: "s3" }),
      basePath: "ota",
    };
  },
  operations: [
    "put",
    "get",
    "exists",
    "delete",
    "listObjects",
    "deleteObjects",
  ],
});
