import { env, secret } from "@hot-updater/core/config";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage as edgeStorage } from "./edge";
import { createEdgeStorageContext } from "./edgeContext";
import { supabaseStorage as nodeStorage } from "./node";
import { SupabaseStorageHttpFake } from "./supabaseStorageV2.test-support";

const nodeContext = (environment: Readonly<Record<string, string>>) =>
  Object.freeze({
    target: "node",
    environment: Object.freeze({ ...environment }),
    bindings: Object.freeze({}),
  }) satisfies StorageOperationContext;

describe("Supabase Storage v2 operation isolation", () => {
  const fake = new SupabaseStorageHttpFake();

  afterEach(() => {
    vi.unstubAllGlobals();
    fake.reset();
  });

  it("isolates concurrent tagged Web operations", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const plugin = edgeStorage({
      bucketName: env("BUCKET"),
      supabaseServiceRoleKey: secret("KEY"),
      supabaseUrl: env("URL"),
    });
    const contexts = ["a", "b", "a"].map((tag, index) =>
      createEdgeStorageContext({
        target: index === 1 ? "edge" : "worker",
        environment: {
          BUCKET: `bucket-${tag}`,
          KEY: `key-${tag}`,
          URL: `https://${tag}.example`,
        },
        bindings: {},
      }),
    );

    const results = await Promise.all(
      contexts.map((context, index) =>
        plugin.put({
          context,
          key: `item-${index}`,
          body: new Uint8Array([index]),
          contentLength: 1,
        }),
      ),
    );

    expect(results.map((result) => result.storageUri)).toEqual([
      "supabase-storage://bucket-a/item-0",
      "supabase-storage://bucket-b/item-1",
      "supabase-storage://bucket-a/item-2",
    ]);
    expect(
      fake.requests.map(({ authorization, host, path }) => ({
        authorization,
        host,
        path,
      })),
    ).toEqual([
      {
        authorization: "Bearer key-a",
        host: "a.example",
        path: "/storage/v1/object/bucket-a/item-0",
      },
      {
        authorization: "Bearer key-b",
        host: "b.example",
        path: "/storage/v1/object/bucket-b/item-1",
      },
      {
        authorization: "Bearer key-a",
        host: "a.example",
        path: "/storage/v1/object/bucket-a/item-2",
      },
    ]);
  });

  it("does not retain tagged Node configuration between operations", async () => {
    vi.stubGlobal("fetch", fake.fetch);
    const plugin = nodeStorage({
      bucketName: env("BUCKET"),
      supabaseServiceRoleKey: secret("KEY"),
      supabaseUrl: env("URL"),
    });

    for (const tag of ["a", "b", "a"]) {
      await plugin.put({
        context: nodeContext({
          BUCKET: `node-${tag}`,
          KEY: `node-key-${tag}`,
          URL: `https://node-${tag}.example`,
        }),
        key: `${tag}-${fake.requests.length}`,
        body: new Uint8Array([1]),
        contentLength: 1,
      });
    }

    expect(
      fake.requests.map(({ authorization, host }) => ({
        authorization,
        host,
      })),
    ).toEqual([
      { authorization: "Bearer node-key-a", host: "node-a.example" },
      { authorization: "Bearer node-key-b", host: "node-b.example" },
      { authorization: "Bearer node-key-a", host: "node-a.example" },
    ]);
  });
});
