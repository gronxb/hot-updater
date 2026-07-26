import { secret } from "@hot-updater/core/config";
import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { readStorageStream } from "@hot-updater/test-utils/storage";
import { describe, expect, it } from "vitest";

import { createFirebaseStorage } from "./storage/firebaseStorage";
import { createFirebaseStorageFake } from "./storage/firebaseStorageTestFake";

const nodeContext = createNodeStorageContext({ environment: {} });

describe("Firebase Storage v2 lifecycle and errors", () => {
  it("caches a literal-derived Admin client until unmount", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: "release-bucket" },
      "node",
      fake.factory,
    );

    await plugin.head({
      context: nodeContext,
      storageUri: "gs://release-bucket/missing-a",
    });
    await plugin.head({
      context: nodeContext,
      storageUri: "gs://release-bucket/missing-b",
    });
    expect(fake.created).toHaveLength(1);
    expect(fake.scopes).toEqual(["cached"]);
    expect(fake.closed).toEqual([]);

    await plugin.onUnmount?.();

    expect(fake.closed).toEqual([0]);
  });

  it("retains a tagged client until its returned stream settles", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: secret("BUCKET") },
      "node",
      fake.factory,
    );
    const context = createNodeStorageContext({
      environment: { BUCKET: "release-bucket" },
    });
    const stored = await plugin.put({
      context,
      key: "stream",
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
    });
    const result = await plugin.get({
      context,
      storageUri: stored.storageUri,
    });

    expect(result.kind).toBe("found");
    expect(fake.closed).toEqual([0]);
    if (result.kind === "found") {
      expect(await readStorageStream(result.body)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    }
    expect(fake.closed).toEqual([0, 1]);
  });

  it("closes a tagged client when a returned stream is aborted", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: secret("BUCKET") },
      "node",
      fake.factory,
    );
    const context = createNodeStorageContext({
      environment: { BUCKET: "release-bucket" },
    });
    const stored = await plugin.put({
      context,
      key: "aborted-stream",
      body: new Uint8Array([1]),
      contentLength: 1,
    });
    const controller = new AbortController();
    const result = await plugin.get({
      context,
      storageUri: stored.storageUri,
      signal: controller.signal,
    });

    controller.abort();

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      await expect(result.body.getReader().read()).rejects.toMatchObject({
        name: "StoragePluginError",
        code: "aborted",
      });
    }
    expect(fake.closed).toEqual([0, 1]);
  });

  it("rejects an out-of-bounds range and closes its tagged client", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: secret("BUCKET") },
      "node",
      fake.factory,
    );
    const context = createNodeStorageContext({
      environment: { BUCKET: "release-bucket" },
    });
    const stored = await plugin.put({
      context,
      key: "range",
      body: new Uint8Array([1, 2]),
      contentLength: 2,
    });

    await expect(
      plugin.get({
        context,
        storageUri: stored.storageUri,
        range: { start: 0, end: 2 },
      }),
    ).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "invalid-input",
    });
    expect(fake.closed).toEqual([0, 1]);
  });

  it("maps Firebase authorization and rate errors without leaking provider text", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: "release-bucket" },
      "node",
      fake.factory,
    );

    for (const [status, code] of [
      [403, "forbidden"],
      [429, "rate-limited"],
    ] as const) {
      fake.failNext(status);
      const error = await plugin
        .head({
          context: nodeContext,
          storageUri: "gs://release-bucket/object",
        })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect(error).toBeInstanceOf(StoragePluginError);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain("seeded provider failure");
    }
  });

  it("issues a signed download with an explicit expiry", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: "release-bucket" },
      "node",
      fake.factory,
    );
    const stored = await plugin.put({
      context: nodeContext,
      key: "signed",
      body: new Uint8Array([1]),
      contentLength: 1,
    });

    const result = await plugin.issueDownload?.({
      context: nodeContext,
      storageUri: stored.storageUri,
      expiresInSeconds: 60,
    });

    expect(result?.kind).toBe("issued");
    expect(result?.downloadUrl).toContain(
      "https://firebase.invalid/release-bucket/signed",
    );
    expect(Date.parse(result?.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("keeps historical gs basePath layout compatible", async () => {
    const fake = createFirebaseStorageFake();
    const plugin = createFirebaseStorage(
      { storageBucket: "release-bucket", basePath: "updates" },
      "node",
      fake.factory,
    );

    const result = await plugin.put({
      context: nodeContext,
      key: "bundle-id/manifest.json",
      body: new Uint8Array([1]),
      contentLength: 1,
    });

    expect(result.storageUri).toBe(
      "gs://release-bucket/updates/bundle-id/manifest.json",
    );
  });
});
