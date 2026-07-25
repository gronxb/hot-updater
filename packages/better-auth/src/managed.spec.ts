import { createHash } from "node:crypto";

import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { createRuntimeDatabase } from "../../server/src/runtime.testFixtures";
import { managedBetterAuthPlugin } from "./managed";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const RAW_API_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const API_KEY_SHA256 = createHash("sha256")
  .update(RAW_API_KEY)
  .digest("base64url");

const createManagedServer = () =>
  createHotUpdater({
    database: createRuntimeDatabase(),
    plugins: [managedBetterAuthPlugin({ apiKeySha256: API_KEY_SHA256 })],
  });

describe("managedBetterAuthPlugin", () => {
  it("rejects a missing or invalid API key across the managed HTTP surface", async () => {
    // Given
    const server = createManagedServer();

    // When
    const responses = await Promise.all([
      server.handler(new Request("https://example.com/api/version")),
      server.handler(
        new Request("https://example.com/api/version", {
          headers: {
            "x-api-key": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          },
        }),
      ),
    ]);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([401, 401]);
  });

  it("accepts repeated and concurrent valid Better Auth API-key sessions", async () => {
    // Given
    const server = createManagedServer();
    const request = () =>
      server.handler(
        new Request("https://example.com/api/version", {
          headers: { "x-api-key": RAW_API_KEY },
        }),
      );

    // When
    const sequential: Response[] = [];
    for (let index = 0; index < 20; index += 1) {
      sequential.push(await request());
    }
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => request()),
    );

    // Then
    expect([...sequential, ...concurrent].map(({ status }) => status)).toEqual(
      Array.from({ length: 40 }, () => 200),
    );
  });

  it("exposes only a Hot Updater manifest and keeps the key principal opaque", async () => {
    // Given
    const manifest = managedBetterAuthPlugin({
      apiKeySha256: API_KEY_SHA256,
    });
    const authentication = manifest.setup(
      createPluginSetupContext(),
    ).authentication;
    const server = createManagedServer();

    // When
    const response = await server.handler(
      new Request("https://example.com/api/version", {
        headers: { "x-api-key": RAW_API_KEY },
      }),
    );
    const result = await authentication?.authenticate({
      headers: new Headers({ "x-api-key": RAW_API_KEY }),
      method: "GET",
      route: {
        access: { kind: "protected" },
        id: "version",
        method: "GET",
        params: {},
        pattern: "/version",
      },
      signal: new AbortController().signal,
      url: new URL("https://example.com/version"),
    });

    // Then
    expect(response.status).toBe(200);
    expect(result).toEqual({
      kind: "authenticated",
      principal: {
        issuer: "better-auth",
        subject: "hot-updater-managed",
      },
    });
    expect(Reflect.has(manifest, "auth")).toBe(false);
    expect(Reflect.has(manifest, "handler")).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(RAW_API_KEY);
    expect(JSON.stringify(manifest)).not.toContain(API_KEY_SHA256);
    expect(JSON.stringify(result)).not.toContain(RAW_API_KEY);
    expect(JSON.stringify(result)).not.toContain(API_KEY_SHA256);
  });

  it.each([
    "",
    "short",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
  ])("rejects a non-canonical SHA-256 projection %#", (apiKeySha256) => {
    // Given / When
    const construct = () => managedBetterAuthPlugin({ apiKeySha256 });

    // Then
    expect(construct).toThrow();
  });
});
