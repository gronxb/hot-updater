import {
  createStorageAdapter,
  type NativeBuildRow,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  downloadNativeBuild,
  listNativeBuilds,
  resolveNativeBuildDownloadUrl,
} from "./nativeBuilds";

const build = (artifactStorageUri: string) =>
  ({
    id: "build-1",
    artifact_storage_uri: artifactStorageUri,
  }) as NativeBuildRow;

const coreWith = (row: NativeBuildRow | null) => ({
  getNativeBuild: vi.fn(async () => row),
});

const apkUri = "r2://updates/native-builds/android/build-1/app%20release.apk";

describe("listNativeBuilds", () => {
  const rows = (...ids: string[]) =>
    ids.map((id) => ({ id }) as NativeBuildRow);

  it("reads the newest page, and the next one after a full page", async () => {
    const core = {
      listNativeBuilds: vi.fn(async () => rows("c", "b")),
    };

    await expect(listNativeBuilds(core, { limit: 2 })).resolves.toEqual({
      data: rows("c", "b"),
      next: "b",
    });
    expect(core.listNativeBuilds).toHaveBeenCalledWith({
      order: "desc",
      limit: 2,
    });
    await expect(
      listNativeBuilds(core, { before: "d", limit: 3 }),
    ).resolves.toEqual({ data: rows("c", "b"), previous: "c" });
    expect(core.listNativeBuilds).toHaveBeenLastCalledWith({
      order: "desc",
      limit: 3,
      after: "d",
    });
  });

  it("reads a previous page oldest first and shows it newest first", async () => {
    const core = {
      listNativeBuilds: vi.fn(async () => rows("b", "c")),
    };

    await expect(
      listNativeBuilds(core, { after: "a", limit: 2 }),
    ).resolves.toEqual({ data: rows("c", "b"), next: "b", previous: "c" });
    expect(core.listNativeBuilds).toHaveBeenCalledWith({
      order: "asc",
      after: "a",
      limit: 2,
    });
  });
});

describe("downloadNativeBuild", () => {
  it("redirects to the storage's download URL, resolved on each request", async () => {
    const getDownloadUrl = vi.fn(async () => ({
      url: "https://r2.example.com/app.apk?signature=1",
    }));
    const storage = createStorageAdapter({
      name: "r2Storage",
      protocol: "r2",
      getDownloadUrl,
    });

    const response = await downloadNativeBuild("build-1", {
      core: coreWith(build(apkUri)),
      storage,
    });

    expect(getDownloadUrl).toHaveBeenCalledWith({ storageUri: apkUri });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://r2.example.com/app.apk?signature=1",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("streams the artifact under its file name when the storage has no URL", async () => {
    const get = vi.fn(async () => ({ response: new Response("apk") }));
    const storage = createStorageAdapter({
      name: "r2Storage",
      protocol: "r2",
      get,
    });

    const response = await downloadNativeBuild("build-1", {
      core: coreWith(build(apkUri)),
      storage,
    });

    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''app%20release.apk",
    );
    await expect(response.text()).resolves.toBe("apk");
  });

  it("redirects to a public URL no storage owns", async () => {
    const response = await downloadNativeBuild("build-1", {
      core: coreWith(build("https://cdn.example.com/app.apk")),
      storage: createStorageAdapter({ name: "r2Storage", protocol: "r2" }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://cdn.example.com/app.apk",
    );
  });

  it("answers 404 for an unknown build", async () => {
    const response = await downloadNativeBuild("build-1", {
      core: coreWith(null),
      storage: createStorageAdapter({ name: "r2Storage", protocol: "r2" }),
    });

    expect(response.status).toBe(404);
  });
});

describe("downloadNativeBuild when the storage gives no usable URL", () => {
  const streamed = {
    get: vi.fn(async () => ({
      response: new Response("apk bytes", {
        headers: { "content-length": "9" },
      }),
    })),
  };
  const storageWith = (getDownloadUrl: () => Promise<{ url: string }>) =>
    createStorageAdapter({
      name: "storage",
      protocol: "r2",
      getDownloadUrl,
      ...streamed,
    });

  it("streams when the storage can't sign, and says why without the object's URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await downloadNativeBuild("build-1", {
      core: coreWith(build(apkUri)),
      storage: storageWith(async () => {
        throw new Error("no signing credential");
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("apk bytes");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("streams when the storage's URL isn't one a browser can fetch", async () => {
    for (const url of ["/internal/app.apk", "file:///tmp/app.apk", ""]) {
      const response = await downloadNativeBuild("build-1", {
        core: coreWith(build(apkUri)),
        storage: storageWith(async () => ({ url })),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-disposition")).toContain(
        "app%20release.apk",
      );
    }
  });

  it("keeps the storage's failure when it can't stream either", async () => {
    await expect(
      downloadNativeBuild("build-1", {
        core: coreWith(build(apkUri)),
        storage: createStorageAdapter({
          name: "storage",
          protocol: "r2",
          getDownloadUrl: async () => {
            throw new Error("no signing credential");
          },
        }),
      }),
    ).rejects.toThrow("no signing credential");
  });
});

describe("resolveNativeBuildDownloadUrl", () => {
  it("returns the storage's download URL, or null when it gives none", async () => {
    const withUrl = createStorageAdapter({
      name: "r2Storage",
      protocol: "r2",
      getDownloadUrl: async () => ({ url: "https://r2.example.com/app.apk" }),
    });
    const withoutUrl = createStorageAdapter({
      name: "r2Storage",
      protocol: "r2",
    });

    await expect(
      resolveNativeBuildDownloadUrl("build-1", {
        core: coreWith(build(apkUri)),
        storage: withUrl,
      }),
    ).resolves.toBe("https://r2.example.com/app.apk");
    await expect(
      resolveNativeBuildDownloadUrl("build-1", {
        core: coreWith(build(apkUri)),
        storage: withoutUrl,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveNativeBuildDownloadUrl("build-1", {
        core: coreWith(null),
        storage: withUrl,
      }),
    ).resolves.toBeNull();
  });
});
