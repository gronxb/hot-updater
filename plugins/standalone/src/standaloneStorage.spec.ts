import { mkdtemp, rm, writeFile } from "node:fs/promises";
// allow: SIZE_OK — live HTTP conformance scenarios share one server lifecycle.
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { createStorageOperationContext } from "@hot-updater/core/config";
import { createStoragePlugin } from "@hot-updater/plugin-core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { storageConformanceAssertions } from "../../../packages/test-utils/src/storage";
import { setupStoragePluginTestRunner } from "../../../packages/test-utils/src/storage/storagePluginTestRunner";
import { standaloneStorage as legacyStandaloneStorage } from "./standaloneStorage";
import {
  createStandaloneStorageHandler,
  STANDALONE_STORAGE_V2,
} from "./standaloneStorageHandler";
import { standaloneStorage } from "./storage";

const context = createStorageOperationContext({
  target: "node",
  environment: {},
  bindings: {},
});
const servers: Server[] = [];
type TestRequestInit = RequestInit & { readonly duplex: "half" };

const listen = async (
  handler: (request: Request) => Promise<Response | undefined>,
): Promise<string> => {
  const server = createServer(async (incoming, outgoing) => {
    const method = incoming.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Readable.toWeb(incoming);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const init =
      body === undefined
        ? ({ method, headers } satisfies RequestInit)
        : ({
            method,
            headers,
            body,
            duplex: "half",
          } satisfies TestRequestInit);
    const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, init);
    const response = await handler(request);
    if (response === undefined) {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      outgoing.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(outgoing);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP test server.");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        }),
    ),
  );
});

const createRemoteMemoryStorage = () => {
  const objects = new Map<
    string,
    Readonly<{
      body: Uint8Array;
      contentType?: string;
      metadata: Readonly<Record<string, string>>;
    }>
  >();
  return createStoragePlugin({
    name: "standaloneRemote",
    protocol: "http",
    plugin: () => ({
      async put(input) {
        const storageUri = `http://storage.test/${encodeURIComponent(input.key)}`;
        if (input.condition === "create-only" && objects.has(storageUri)) {
          return { kind: "already-exists", storageUri };
        }
        const body =
          input.body instanceof Uint8Array
            ? input.body
            : new Uint8Array(await new Response(input.body).arrayBuffer());
        objects.set(storageUri, {
          body,
          ...(input.contentType === undefined
            ? {}
            : { contentType: input.contentType }),
          metadata: input.metadata ?? {},
        });
        return { kind: "stored", storageUri };
      },
      async head(input) {
        const object = objects.get(input.storageUri);
        return object === undefined
          ? { kind: "not-found" }
          : {
              kind: "found",
              storageUri: input.storageUri,
              metadata: {
                contentLength: object.body.byteLength,
                ...(object.contentType === undefined
                  ? {}
                  : { contentType: object.contentType }),
                custom: object.metadata,
              },
            };
      },
      async get(input) {
        const object = objects.get(input.storageUri);
        if (object === undefined) return { kind: "not-found" };
        const body = object.body;
        const end = Math.min(
          input.range?.end ?? body.byteLength - 1,
          body.byteLength - 1,
        );
        const bytes =
          input.range === undefined
            ? body
            : body.slice(input.range.start, end + 1);
        return {
          kind: "found",
          storageUri: input.storageUri,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          metadata: {
            contentLength: body.byteLength,
            ...(object.contentType === undefined
              ? {}
              : { contentType: object.contentType }),
            custom: object.metadata,
          },
          ...(input.range === undefined
            ? {}
            : {
                range: {
                  start: input.range.start,
                  end,
                  totalLength: body.byteLength,
                },
              }),
        };
      },
      async delete(input) {
        return objects.delete(input.storageUri)
          ? { kind: "deleted" }
          : { kind: "not-found" };
      },
      async issueDownload(input) {
        return {
          kind: "issued",
          downloadUrl: `https://cdn.test/?source=${encodeURIComponent(input.storageUri)}`,
        };
      },
    }),
  });
};

setupStoragePluginTestRunner(
  {
    name: "standalone storage v2 over HTTP",
    context,
    async createPlugin() {
      const remote = createRemoteMemoryStorage();
      const baseUrl = await listen(
        createStandaloneStorageHandler({
          context,
          storage: remote,
        }),
      );
      return standaloneStorage({ baseUrl });
    },
  },
  ({ context: testContext, getPlugin }) => {
    it("byte-round-trip", async () => {
      await storageConformanceAssertions.byteRoundTrip(
        getPlugin(),
        testContext,
      );
    });
    it("stream-round-trip", async () => {
      await storageConformanceAssertions.streamRoundTrip(
        getPlugin(),
        testContext,
      );
    });
    it("atomic-create-only", async () => {
      await storageConformanceAssertions.atomicCreateOnly(
        getPlugin(),
        testContext,
      );
    });
    it("inclusive-range-and-metadata", async () => {
      await storageConformanceAssertions.inclusiveRangeAndMetadata(
        getPlugin(),
        testContext,
      );
    });
    it("head-and-not-found", async () => {
      await storageConformanceAssertions.headAndNotFound(
        getPlugin(),
        testContext,
      );
    });
    it("exact-idempotent-delete", async () => {
      await storageConformanceAssertions.exactIdempotentDelete(
        getPlugin(),
        testContext,
      );
    });
    it("cancellation-cancels-input-stream", async () => {
      await storageConformanceAssertions.cancellationCancelsInputStream(
        getPlugin(),
        testContext,
      );
    });
    it("uri-validation", async () => {
      await storageConformanceAssertions.uriValidation(
        getPlugin(),
        testContext,
      );
    });
    it("unmount-is-idempotent", async () => {
      await storageConformanceAssertions.unmountIsIdempotent(
        getPlugin(),
        testContext,
      );
    });
  },
);

describe("legacy standaloneStorage", () => {
  it("waits for the upload hook before resolving", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "hot-updater-"));
    const filePath = path.join(tempDir, "bundle.zip");
    await writeFile(filePath, "bundle");
    let hookDone = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ storageUri: "http://localhost/bundle.zip" }),
          {
            status: 200,
          },
        );
      }),
    );

    const storage = legacyStandaloneStorage(
      {
        baseUrl: "http://localhost",
      },
      {
        onStorageUploaded: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                hookDone = true;
                resolve();
              }, 10);
            }),
        ),
      },
    )();

    try {
      await expect(
        storage.profiles.node.upload("bundle-id", filePath),
      ).resolves.toEqual({
        storageUri: "http://localhost/bundle.zip",
      });
      expect(hookDone).toBe(true);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("checks object existence with the resolved download URL", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === "http://localhost/getDownloadUrl") {
        return new Response(
          JSON.stringify({ fileUrl: "https://cdn.example.com/bundle.zip" }),
          { status: 200 },
        );
      }

      expect(String(input)).toBe("https://cdn.example.com/bundle.zip");
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const storage = legacyStandaloneStorage({
      baseUrl: "http://localhost",
    })();

    await expect(
      storage.profiles.node.exists("http://localhost/bundle.zip"),
    ).resolves.toBe(true);
  });
});

describe("standalone storage v2 wire contract", () => {
  it("uses the collision-free versioned object routes", () => {
    expect(STANDALONE_STORAGE_V2.routes).toEqual({
      delivery: "/hot-updater/storage/v2/delivery",
      object: "/hot-updater/storage/v2/objects",
    });
  });
});
