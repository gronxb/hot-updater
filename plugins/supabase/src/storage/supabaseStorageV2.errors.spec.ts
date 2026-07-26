import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./node";
import { SupabaseStorageHttpFake } from "./supabaseStorageV2.test-support";

const context = Object.freeze({
  target: "node",
  environment: Object.freeze({}),
  bindings: Object.freeze({}),
}) satisfies StorageOperationContext;

describe("Supabase Storage v2 errors", () => {
  const fake = new SupabaseStorageHttpFake();

  afterEach(() => {
    vi.unstubAllGlobals();
    fake.reset();
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
  ] as const)("maps HTTP %s to typed %s errors", async (status, code) => {
    vi.stubGlobal("fetch", fake.fetch);
    const plugin = supabaseStorage({
      bucketName: "updates",
      supabaseServiceRoleKey: "canary-secret",
      supabaseUrl: "https://project.example",
    });
    fake.failNext(status, {
      message: "provider rejected request",
      statusCode: String(status),
    });

    const failure = await plugin
      .head({
        context,
        storageUri: "supabase-storage://updates/item",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoragePluginError);
    expect(failure).toMatchObject({ code, status });
    expect(String(failure)).not.toContain("canary-secret");
  });

  it("maps non-JSON HTTP failures without exposing provider payloads", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const plugin = supabaseStorage({
      bucketName: "updates",
      supabaseServiceRoleKey: "key",
      supabaseUrl: "https://project.example",
    });
    fake.failNext(500, "not-json");

    await expect(
      plugin.head({
        context,
        storageUri: "supabase-storage://updates/item",
      }),
    ).rejects.toMatchObject({
      code: "provider",
      message: "Supabase Storage request failed (500).",
      status: 500,
    });
  });

  it("rejects provider responses with the wrong byte range", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const plugin = supabaseStorage({
      bucketName: "updates",
      supabaseServiceRoleKey: "key",
      supabaseUrl: "https://project.example",
    });
    const stored = await plugin.put({
      context,
      key: "range",
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
    });
    fake.setWrongRange(true);

    await expect(
      plugin.get({
        context,
        storageUri: stored.storageUri,
        range: { start: 1, end: 2 },
      }),
    ).rejects.toMatchObject({
      code: "provider",
      message: "Supabase Storage returned an invalid byte range.",
    });
  });
});
