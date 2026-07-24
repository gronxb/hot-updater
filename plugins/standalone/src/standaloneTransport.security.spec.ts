import { createServer, type RequestListener, type Server } from "node:http";

import { analyticsProviderToken } from "@hot-updater/analytics/provider";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";

import { standaloneRepository } from "./standaloneRepository";
import { standaloneStorage } from "./standaloneStorage";
import {
  createStandaloneTransport,
  StandaloneTransportError,
} from "./standaloneTransport";

const SECRET = "security-canary-never-disclose";
const servers: Server[] = [];

class MissingCapabilityError extends Error {}

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
    const [contribution] = getCapabilityContributions(repository);
    if (contribution === undefined) throw new MissingCapabilityError();
    const analytics = analyticsProviderToken.parse(
      contribution.create({ database: repository, storages: [] }),
    );
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
