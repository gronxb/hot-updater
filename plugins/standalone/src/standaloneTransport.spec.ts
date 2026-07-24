import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneHttp } from "./standaloneHttp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone credentialed transport", () => {
  it("rejects base URL user information during construction", () => {
    // Given
    const config = {
      baseUrl: "https://user:secret@trusted.example/provider",
      commonHeaders: { Authorization: "Bearer outbound" },
    };

    // When
    const createTransport = () => createStandaloneHttp(config);

    // Then
    expect(createTransport).toThrow();
  });

  it.each([
    "https://evil.example/steal",
    "//evil.example/steal",
    String.raw`\evil.example\steal`,
    "/safe#fragment",
    "../escape",
    "/safe/@evil.example",
  ])(
    "rejects the unsafe destination %s before reading credentials",
    async (path) => {
      // Given
      let credentialReads = 0;
      const commonHeaders = {
        get Authorization() {
          credentialReads += 1;
          return "Bearer outbound";
        },
      };
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetch);
      const http = createStandaloneHttp({
        baseUrl: "https://trusted.example/provider/",
        commonHeaders,
      });

      // When
      const request = http.load(
        { path },
        {},
        (value): value is object => typeof value === "object" && value !== null,
        "Invalid response.",
      );

      // Then
      await expect(request).rejects.toThrow();
      expect(credentialReads).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves the base path and configured outbound credentials", async () => {
    // Given
    let observedRequest: Request | undefined;
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        observedRequest = new Request(input, init);
        return Response.json({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const outboundConfig = {
      baseUrl: "https://trusted.example/provider",
      commonHeaders: { Authorization: "Bearer outbound" },
      headers: {
        Authorization: "Bearer inbound",
        Cookie: "inbound-session=secret",
      },
      principal: { id: "inbound-principal" },
    };
    const http = createStandaloneHttp(outboundConfig);

    // When
    await http.load(
      {
        path: "/v1/bundles",
        headers: { "X-Route-Secret": "route-secret" },
      },
      {},
      (value): value is object => typeof value === "object" && value !== null,
      "Invalid response.",
    );

    // Then
    expect(observedRequest?.url).toBe(
      "https://trusted.example/provider/v1/bundles",
    );
    expect(observedRequest?.redirect).toBe("error");
    expect(observedRequest?.headers.get("Authorization")).toBe(
      "Bearer outbound",
    );
    expect(observedRequest?.headers.get("X-Route-Secret")).toBe("route-secret");
    expect(observedRequest?.headers.get("Cookie")).toBeNull();
  });
});
