import { createServer, type RequestListener, type Server } from "node:http";
// allow: SIZE_OK — security scenarios share one canary and redirect harness.

import { env, secret } from "@hot-updater/core/config";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneAnalyticsProvider } from "./standaloneAnalyticsProvider";
import { standaloneRepository } from "./standaloneRepository";
import { standaloneStorage } from "./standaloneStorage";
import {
  createStandaloneStorageHandler,
  STANDALONE_STORAGE_V2,
} from "./standaloneStorageHandler";
import {
  createStandaloneTransport,
  StandaloneTransportError,
} from "./standaloneTransport";
import { standaloneStorage as standaloneStorageV2 } from "./storage";

const SECRET = "security-canary-never-disclose";
const servers: Server[] = [];

const listen = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler);
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
  vi.restoreAllMocks();
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

describe("standalone transport security boundary", () => {
  it("rejects base URL user information with a stable opaque error", () => {
    // Given
    const baseUrl = `https://user:${SECRET}@trusted.example/provider`;

    // When
    const construct = () => createStandaloneTransport({ baseUrl });

    // Then
    expect(construct).toThrowError(StandaloneTransportError);
    expect(construct).toThrowError(
      expect.objectContaining({
        code: "invalid-base-url",
        message: "Standalone transport configuration is invalid.",
        name: "StandaloneTransportError",
      }),
    );
  });

  it.each([
    "https://trusted.example/provider/absolute",
    "https://evil.example/absolute",
    "//evil.example/scheme-relative",
    String.raw`\evil.example\backslash`,
    "/safe#fragment",
    "../base-path-escape",
    "/nested/../../base-path-escape",
    "/nested/%2e%2e/base-path-escape",
    "/nested/%252e%252e/double-encoded-escape",
    "/safe/@evil.example/userinfo",
  ])("rejects %s before reading configured credentials", (path) => {
    // Given
    let credentialReads = 0;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const transport = createStandaloneTransport({
      baseUrl: "https://trusted.example/provider",
      commonHeaders: {
        get Authorization() {
          credentialReads += 1;
          return `Bearer ${SECRET}`;
        },
      },
    });

    // When
    const request = () => transport.request({ path }, { method: "GET" });

    // Then
    expect(request).toThrowError(
      expect.objectContaining({
        code: "invalid-destination",
        name: "StandaloneTransportError",
      }),
    );
    expect(credentialReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("canonicalizes host, IDN, and default port while preserving the base path", () => {
    // Given
    const transport = createStandaloneTransport({
      baseUrl: "https://BÜCHER.example:443/provider",
    });

    // When
    const destination = transport.resolve("/v1/bundles?channel=production");

    // Then
    expect(destination.href).toBe(
      "https://xn--bcher-kva.example/provider/v1/bundles?channel=production",
    );
    expect(destination.origin).toBe("https://xn--bcher-kva.example");
  });

  it("rejects credential-bearing redirects without contacting the target", async () => {
    // Given
    const targetRequests: string[] = [];
    const targetUrl = await listen((request, response) => {
      targetRequests.push(JSON.stringify(request.headers));
      response.end("unexpected");
    });
    let sourceAuthorization: string | undefined;
    const sourceUrl = await listen((request, response) => {
      sourceAuthorization = request.headers.authorization;
      response.writeHead(302, { Location: `${targetUrl}/collect` });
      response.end();
    });
    const transport = createStandaloneTransport({
      baseUrl: sourceUrl,
      commonHeaders: { Authorization: `Bearer ${SECRET}` },
    });

    // When
    const request = transport.request({ path: "/redirect" }, { method: "GET" });

    // Then
    await expect(request).rejects.toThrow();
    expect(sourceAuthorization).toBe(`Bearer ${SECRET}`);
    expect(targetRequests).toEqual([]);
  });

  it("keeps repository, Analytics, and storage control traffic on the seam", async () => {
    // Given
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/version")) {
          return Response.json({
            capabilities: {
              analytics: true,
              analyticsQueries: true,
              eventIngestion: true,
              mode: "dedicated",
            },
            version: "1.0.0",
          });
        }
        if (request.url.endsWith("/channels")) {
          return Response.json({ data: { channels: [] } });
        }
        if (request.url.endsWith("/events")) return Response.json({});
        return new Response("manifest");
      }),
    );
    const outbound = {
      Authorization: `Bearer ${SECRET}`,
      Cookie: `session=${SECRET}`,
      "X-API-Key": SECRET,
    };
    const repositoryConfig = {
      baseUrl: "https://TRUSTED.example:443/provider",
      commonHeaders: outbound,
      headers: {
        Authorization: "Bearer inbound",
        Cookie: "inbound-cookie",
        "X-API-Key": "inbound-key",
        "X-Principal": "inbound-principal",
      },
      principal: { subject: "inbound-principal" },
      routes: {
        appendEvent: () => ({
          headers: { "X-Route": "analytics" },
          path: "/events",
        }),
        channels: () => ({
          headers: { "X-Route": "repository" },
          path: "/channels",
        }),
      },
    };
    const repository = standaloneRepository(repositoryConfig);
    const analytics = createStandaloneAnalyticsProvider(repositoryConfig);
    const storage = standaloneStorage({
      baseUrl: repositoryConfig.baseUrl,
      commonHeaders: outbound,
    })();

    // When
    await repository.getChannels?.();
    await analytics.resolveAvailability?.(new AbortController().signal);
    await analytics.appendBundleEvent({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprintHash: null,
      fromBundleId: null,
      installId: "install-1",
      platform: "ios",
      sdkVersion: "1.2.3",
      toBundleId: "bundle-1",
      type: "UNCHANGED",
      updateStrategy: null,
    });
    await storage.profiles.runtime.readText("storage://manifest");

    // Then
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.url).toMatch(/^https:\/\/trusted\.example\/provider\//);
      expect(request.redirect).toBe("error");
      expect(request.headers.get("Authorization")).toBe(outbound.Authorization);
      expect(request.headers.get("Cookie")).toBe(outbound.Cookie);
      expect(request.headers.get("X-API-Key")).toBe(outbound["X-API-Key"]);
      expect(request.headers.get("X-Principal")).toBeNull();
    }
    expect(requests[0]?.headers.get("X-Route")).toBe("repository");
    expect(requests[2]?.headers.get("X-Route")).toBe("analytics");
  });

  it("keeps reflected upstream secrets out of errors and logs", async () => {
    // Given
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: SECRET }, { status: 502, statusText: SECRET }),
      ),
    );
    const repository = standaloneRepository({
      baseUrl: "https://trusted.example/provider",
      commonHeaders: { Authorization: `Bearer ${SECRET}` },
    });
    const storage = standaloneStorage({
      baseUrl: "https://trusted.example/provider",
      commonHeaders: { Authorization: `Bearer ${SECRET}` },
    })();

    // When
    const results = await Promise.allSettled([
      repository.getChannels?.(),
      storage.profiles.runtime.getDownloadUrl("storage://manifest"),
    ]);

    // Then
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).not.toContain(SECRET);
      }
    }
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SECRET);
    expect(results[0]).toEqual(
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "request-failed",
          status: 502,
        }),
      }),
    );
  });
});

const storageContext = (
  environment: Readonly<Record<string, string>>,
): StorageOperationContext =>
  Object.freeze({
    target: "node",
    environment: Object.freeze(environment),
    bindings: Object.freeze({}),
  });

describe("standalone storage v2 security boundary", () => {
  it("resolves tagged endpoint and headers per operation in A-B-A order", async () => {
    // Given
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          downloadUrl: `https://cdn.example/${requests.length}`,
        });
      }),
    );
    const storage = standaloneStorageV2({
      baseUrl: env("BASE_URL"),
      commonHeaders: { Authorization: secret("TOKEN") },
      routes: {
        delivery: {
          path: "/custom/v2/delivery",
          headers: { "X-Route-Context": env("ROUTE_CONTEXT") },
        },
      },
    });
    const contexts = [
      storageContext({
        BASE_URL: "https://a.example/api",
        TOKEN: "token-a-1",
        ROUTE_CONTEXT: "route-a-1",
      }),
      storageContext({
        BASE_URL: "https://b.example/api",
        TOKEN: "token-b",
        ROUTE_CONTEXT: "route-b",
      }),
      storageContext({
        BASE_URL: "https://a.example/api",
        TOKEN: "token-a-2",
        ROUTE_CONTEXT: "route-a-2",
      }),
    ];

    // When
    for (const context of contexts) {
      await storage.issueDownload?.({
        context,
        storageUri: "https://objects.example/item",
      });
    }

    // Then
    expect(requests.map((request) => request.url)).toEqual([
      "https://a.example/api/custom/v2/delivery",
      "https://b.example/api/custom/v2/delivery",
      "https://a.example/api/custom/v2/delivery",
    ]);
    expect(
      requests.map((request) => request.headers.get("authorization")),
    ).toEqual(["token-a-1", "token-b", "token-a-2"]);
    expect(
      requests.map((request) => request.headers.get("x-route-context")),
    ).toEqual(["route-a-1", "route-b", "route-a-2"]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
    [500, "provider"],
  ] as const)("maps HTTP %i to the typed %s error", async (status, code) => {
    // Given
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(SECRET, { status })),
    );
    const storage = standaloneStorageV2({
      baseUrl: "https://trusted.example",
      commonHeaders: { Authorization: `Bearer ${SECRET}` },
    });

    // When
    const operation = storage.head({
      context: storageContext({}),
      storageUri: "https://objects.example/item",
    });

    // Then
    await expect(operation).rejects.toMatchObject({
      code,
      message: "Standalone storage request failed.",
      status,
    });
    await expect(operation).rejects.not.toThrow(SECRET);
  });

  it("rejects malformed and truncated object responses", async () => {
    // Given
    const responses = [
      new Response("ab", {
        status: 206,
        headers: {
          "content-range": "bytes invalid",
          "content-length": "2",
          [STANDALONE_STORAGE_V2.headers.contentLength]: "3",
          [STANDALONE_STORAGE_V2.headers.metadata]: "%7B%7D",
          [STANDALONE_STORAGE_V2.headers.storageUri]:
            "https%3A%2F%2Fobjects.example%2Fitem",
        },
      }),
      new Response("ab", {
        status: 200,
        headers: {
          "content-length": "2",
          [STANDALONE_STORAGE_V2.headers.contentLength]: "3",
          [STANDALONE_STORAGE_V2.headers.metadata]: "%7B%7D",
          [STANDALONE_STORAGE_V2.headers.storageUri]:
            "https%3A%2F%2Fobjects.example%2Fitem",
        },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()),
    );
    const storage = standaloneStorageV2({
      baseUrl: "https://trusted.example",
    });
    const context = storageContext({});

    // When
    const badRange = storage.get({
      context,
      storageUri: "https://objects.example/item",
      range: { start: 0, end: 1 },
    });

    // Then
    await expect(badRange).rejects.toMatchObject({ code: "provider" });
    const truncated = await storage.get({
      context,
      storageUri: "https://objects.example/item",
    });
    if (truncated.kind !== "found") {
      throw new Error("Expected the truncation fixture to be found.");
    }
    await expect(
      new Response(truncated.body).arrayBuffer(),
    ).rejects.toMatchObject({ code: "integrity" });
  });

  it("maps aborted control requests without leaking common headers", async () => {
    // Given
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    const storage = standaloneStorageV2({
      baseUrl: "https://trusted.example",
      commonHeaders: { Authorization: `Bearer ${SECRET}` },
    });

    // When
    const operation = storage.head({
      context: storageContext({}),
      storageUri: "https://objects.example/item",
    });

    // Then
    await expect(operation).rejects.toMatchObject({ code: "aborted" });
    await expect(operation).rejects.not.toThrow(SECRET);
  });

  it("authorizes every v2 control method before storage access", async () => {
    // Given
    const calls: string[] = [];
    const storage = {
      name: "guarded",
      protocol: "http",
      async put() {
        calls.push("put");
        return {
          kind: "stored" as const,
          storageUri: "https://objects.example/item",
        };
      },
      async head() {
        calls.push("head");
        return { kind: "not-found" as const };
      },
      async get() {
        calls.push("get");
        return { kind: "not-found" as const };
      },
      async delete() {
        calls.push("delete");
        return { kind: "not-found" as const };
      },
      async issueDownload() {
        calls.push("delivery");
        return {
          kind: "issued" as const,
          downloadUrl: "https://cdn.example/item",
        };
      },
    };
    const handler = createStandaloneStorageHandler({
      storage,
      context: storageContext({}),
      authorize: () => false,
    });
    const cases = [
      ["PUT", STANDALONE_STORAGE_V2.routes.object],
      ["HEAD", STANDALONE_STORAGE_V2.routes.object],
      ["GET", STANDALONE_STORAGE_V2.routes.object],
      ["DELETE", STANDALONE_STORAGE_V2.routes.object],
      ["POST", STANDALONE_STORAGE_V2.routes.delivery],
    ] as const;

    // When
    const responses = await Promise.all(
      cases.map(([method, route]) =>
        handler(new Request(`https://server.example${route}`, { method })),
      ),
    );

    // Then
    expect(responses.map((response) => response?.status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    expect(calls).toEqual([]);
  });

  it("keeps the root custom-server storage export legacy-only", () => {
    // Given
    const legacy = standaloneStorage({
      baseUrl: "https://legacy.example",
    })();

    // When
    const publicKeys = Object.keys(legacy);

    // Then
    expect(publicKeys).toEqual(["name", "supportedProtocol", "profiles"]);
    expect("protocol" in legacy).toBe(false);
    expect("put" in legacy).toBe(false);
  });
});
