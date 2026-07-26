import { PassThrough, Readable } from "node:stream";

import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { readStorageStream } from "@hot-updater/test-utils/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adminFake = vi.hoisted(() => {
  const initializedApps: Array<{
    name: string;
    options: unknown;
  }> = [];
  const writeOptions: unknown[] = [];
  const readOptions: unknown[] = [];
  const deleteApp = vi.fn(async () => {});
  const file = {
    createWriteStream: vi.fn((options: unknown) => {
      writeOptions.push(options);
      return new PassThrough();
    }),
    getMetadata: vi.fn(async () => [
      {
        size: "4",
        contentType: "application/octet-stream",
        metadata: { release: "stable" },
        updated: "2026-07-27T00:00:00.000Z",
      },
    ]),
    createReadStream: vi.fn((options: unknown) => {
      readOptions.push(options);
      return Readable.from([new Uint8Array([2, 3])]);
    }),
    delete: vi.fn(async () => [{}]),
    getSignedUrl: vi.fn(async () => ["https://firebase.invalid/signed"]),
  };
  const bucket = { file: vi.fn(() => file) };
  return {
    bucket,
    deleteApp,
    file,
    initializedApps,
    readOptions,
    writeOptions,
    getApps: vi.fn((): Array<{ name: string; options: unknown }> => []),
    initializeApp: vi.fn((options: unknown, name?: string) => {
      const app = { name: name ?? "[DEFAULT]", options };
      initializedApps.push(app);
      return app;
    }),
    getStorage: vi.fn(() => ({ bucket: vi.fn(() => bucket) })),
  };
});

vi.mock("firebase-admin/app", () => ({
  deleteApp: adminFake.deleteApp,
  getApps: adminFake.getApps,
  initializeApp: adminFake.initializeApp,
}));

vi.mock("firebase-admin/storage", () => ({
  getStorage: adminFake.getStorage,
}));

import { createFirebaseAdminClient } from "./storage/firebaseAdmin";
import { firebaseStorage } from "./storage/node";

const nodeContext = createNodeStorageContext({ environment: {} });

describe("Firebase Admin Storage adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminFake.initializedApps.length = 0;
    adminFake.readOptions.length = 0;
    adminFake.writeOptions.length = 0;
    adminFake.getApps.mockReturnValue([]);
  });

  it("uses generation zero for atomic create-only uploads", async () => {
    const handle = await createFirebaseAdminClient(
      {
        appOptions: { projectId: "project-a" },
        storageBucket: "release-bucket",
      },
      "operation",
    );

    await handle.client.put({
      key: "updates/object",
      body: new Uint8Array([1, 2, 3, 4]),
      contentLength: 4,
      createOnly: true,
    });

    expect(adminFake.writeOptions).toEqual([
      expect.objectContaining({
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
    ]);
    await handle.close();
    expect(adminFake.deleteApp).toHaveBeenCalledWith(
      adminFake.initializedApps[0],
    );
  });

  it("streams inclusive ranges and provider metadata without buffering", async () => {
    const handle = await createFirebaseAdminClient(
      { appOptions: {}, storageBucket: "release-bucket" },
      "operation",
    );

    const result = await handle.client.get("updates/object", {
      start: 1,
      end: 2,
    });

    expect(adminFake.readOptions).toEqual([{ start: 1, end: 2 }]);
    expect(await readStorageStream(result.body)).toEqual(
      new Uint8Array([2, 3]),
    );
    expect(result.metadata).toMatchObject({
      contentLength: 4,
      contentType: "application/octet-stream",
      custom: { release: "stable" },
    });
  });

  it("isolates literal configs from pre-existing Firebase apps", async () => {
    const foreignApp = { name: "[DEFAULT]", options: { projectId: "foreign" } };
    const credentialA = {
      getAccessToken: vi.fn(async () => ({
        access_token: "configured-a",
        expires_in: 3600,
      })),
    };
    const credentialB = {
      getAccessToken: vi.fn(async () => ({
        access_token: "configured-b",
        expires_in: 3600,
      })),
    };
    adminFake.getApps.mockReturnValue([foreignApp]);

    const pluginA = firebaseStorage({
      credential: credentialA,
      projectId: "configured-a",
      storageBucket: "bucket-a",
    });
    const pluginB = firebaseStorage({
      credential: credentialB,
      projectId: "configured-b",
      storageBucket: "bucket-b",
    });

    await pluginA.head({
      context: nodeContext,
      storageUri: "gs://bucket-a/updates/a",
    });
    await pluginB.head({
      context: nodeContext,
      storageUri: "gs://bucket-b/updates/b",
    });

    expect(adminFake.initializeApp).toHaveBeenNthCalledWith(
      1,
      {
        credential: credentialA,
        projectId: "configured-a",
        storageBucket: "bucket-a",
      },
      expect.stringMatching(/^hot-updater-storage-/u),
    );
    expect(adminFake.initializeApp).toHaveBeenNthCalledWith(
      2,
      {
        credential: credentialB,
        projectId: "configured-b",
        storageBucket: "bucket-b",
      },
      expect.stringMatching(/^hot-updater-storage-/u),
    );
    expect(adminFake.initializedApps[0]?.name).not.toBe(
      adminFake.initializedApps[1]?.name,
    );
    expect(adminFake.getStorage).toHaveBeenNthCalledWith(
      1,
      adminFake.initializedApps[0],
    );
    expect(adminFake.getStorage).toHaveBeenNthCalledWith(
      2,
      adminFake.initializedApps[1],
    );
    expect(adminFake.getStorage).not.toHaveBeenCalledWith(foreignApp);

    await pluginA.onUnmount?.();
    await pluginA.onUnmount?.();
    await pluginB.onUnmount?.();
    await pluginB.onUnmount?.();

    expect(adminFake.deleteApp).toHaveBeenCalledTimes(2);
    expect(adminFake.deleteApp).toHaveBeenCalledWith(
      adminFake.initializedApps[0],
    );
    expect(adminFake.deleteApp).toHaveBeenCalledWith(
      adminFake.initializedApps[1],
    );
    expect(adminFake.deleteApp).not.toHaveBeenCalledWith(foreignApp);
  });
});
