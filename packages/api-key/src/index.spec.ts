import type { HotUpdaterPluginSetupContext } from "@hot-updater/server/internal/first-party-plugin";
import { describe, expect, it } from "vitest";

import { apiKey } from "./index";

const API_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const authenticationInput = (headers: Headers) => ({
  headers,
  method: "GET" as const,
  route: {
    access: { kind: "protected" as const },
    id: "version",
    method: "GET" as const,
    params: Object.freeze({}),
    pattern: "/version" as const,
  },
  signal: new AbortController().signal,
  url: new URL("https://example.com/version"),
});

const contributionFrom = async (options?: Parameters<typeof apiKey>[0]) =>
  apiKey(options ?? { sha256: await sha256(API_KEY) }).setup(
    undefined as unknown as HotUpdaterPluginSetupContext,
  );

describe("apiKey", () => {
  it("authenticates the exact API key without projecting an API", async () => {
    // Given
    const contribution = await contributionFrom();
    const authentication = contribution.authentication;
    if (authentication === undefined) {
      throw new Error("API key authentication was not contributed.");
    }

    // When
    const result = await authentication.authenticate(
      authenticationInput(new Headers({ "x-api-key": API_KEY })),
    );

    // Then
    expect(result).toEqual({
      kind: "authenticated",
      principal: {
        issuer: "hot-updater-api-key",
        subject: "managed",
      },
    });
    expect(Reflect.ownKeys(contribution).sort()).toEqual([
      "authentication",
      "routePolicy",
    ]);
    expect(contribution.routePolicy).toEqual({ kind: "protect-all" });
  });

  it.each([
    ["missing", undefined],
    ["incorrect", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    ["short", "abc"],
    ["padded", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
    ["non-base64url", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!"],
    ["oversized", "A".repeat(513)],
  ])("treats a %s header as anonymous", async (_name, value) => {
    // Given
    const contribution = await contributionFrom();
    const authentication = contribution.authentication;
    if (authentication === undefined) {
      throw new Error("API key authentication was not contributed.");
    }
    const headers = new Headers();
    if (value !== undefined) headers.set("x-api-key", value);

    // When
    const result = await authentication.authenticate(
      authenticationInput(headers),
    );

    // Then
    expect(result).toEqual({ kind: "anonymous" });
  });

  it("supports a validated custom header without mutating request headers", async () => {
    // Given
    const contribution = await contributionFrom({
      headerName: "X-Hot-Updater-Key",
      sha256: await sha256(API_KEY),
    });
    const authentication = contribution.authentication;
    if (authentication === undefined) {
      throw new Error("API key authentication was not contributed.");
    }
    const headers = new Headers({ "x-hot-updater-key": API_KEY });
    const before = [...headers.entries()];

    // When
    const result = await authentication.authenticate(
      authenticationInput(headers),
    );

    // Then
    expect(result.kind).toBe("authenticated");
    expect([...headers.entries()]).toEqual(before);
  });

  it.each(["", "x api key", "x-api-key\ninjected", "a".repeat(129)])(
    "rejects an invalid custom header name",
    async (headerName) => {
      // Given
      const digest = await sha256(API_KEY);

      // When / Then
      expect(() => apiKey({ headerName, sha256: digest })).toThrow(
        "headerName",
      );
    },
  );

  it.each([
    "",
    "abc",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
    "__________________________________________9",
  ])("rejects a non-canonical 32-byte SHA-256 digest", (digest) => {
    // When / Then
    expect(() => apiKey({ sha256: digest })).toThrow("sha256");
  });
});
