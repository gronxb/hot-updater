import { afterEach, describe, expect, it, vi } from "vitest";

import { standaloneStorage } from "./standaloneStorage";

describe("standaloneStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads the runtime-neutral body through the HTTP transport", async () => {
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const formData = init?.body;
      expect(formData).toBeInstanceOf(FormData);
      expect((formData as FormData).get("key")).toBe("bundle-id/bundle.zip");
      const file = (formData as FormData).get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("bundle.zip");
      await expect((file as File).text()).resolves.toBe("bundle");
      return Response.json({ storageUri: "s3://updates/bundle.zip" });
    });
    vi.stubGlobal("fetch", fetch);
    const storage = standaloneStorage({
      baseUrl: "https://repo.example.com",
      protocol: "s3",
    });

    await expect(
      storage.put({
        key: "bundle-id/bundle.zip",
        body: new Blob(["bundle"]).stream(),
        contentLength: 6,
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "s3://updates/bundle.zip",
    });
  });

  it("checks object existence through the flat HTTP operation", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost/exists");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        JSON.stringify({ storageUri: "http://localhost/bundle.zip" }),
      );
      return Response.json({ exists: true });
    });
    vi.stubGlobal("fetch", fetch);
    const storage = standaloneStorage({
      baseUrl: "http://localhost",
      protocol: "http",
    });

    await expect(
      storage.exists({ storageUri: "http://localhost/bundle.zip" }),
    ).resolves.toEqual({ exists: true });
  });

  it("returns the remote object response directly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bundle", {
            headers: { "content-type": "application/zip" },
          }),
      ),
    );
    const storage = standaloneStorage({
      baseUrl: "http://localhost",
      protocol: "http",
    });

    const { response } = await storage.get({
      storageUri: "http://localhost/bundle.zip",
    });

    expect(response?.headers.get("content-type")).toBe("application/zip");
    await expect(response?.text()).resolves.toBe("bundle");
  });

  it("deletes exactly the supplied storage URI", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost/delete");
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBe(
        JSON.stringify({ storageUri: "https://cdn.example.com/bundle.zip" }),
      );
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const storage = standaloneStorage({
      baseUrl: "http://localhost",
      protocol: "https",
    });

    await expect(
      storage.delete({
        storageUri: "https://cdn.example.com/bundle.zip",
      }),
    ).resolves.toEqual({ deleted: true });

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps transport and storage ownership protocols independent", () => {
    const storage = standaloneStorage({
      baseUrl: "https://repo.example.com",
      protocol: "s3",
    });

    expect(storage.protocol).toBe("s3");
  });

  it("rejects a PUT response outside the configured protocol", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ storageUri: "https://cdn.example.com/bundle.zip" }),
      ),
    );
    const storage = standaloneStorage({
      baseUrl: "https://repo.example.com",
      protocol: "s3",
    });

    await expect(
      storage.put({
        key: "bundle.zip",
        body: new Blob(["bundle"]).stream(),
        contentType: "application/zip",
      }),
    ).rejects.toThrow("Expected s3, got https");
  });

  it.each(["get", "exists", "delete"] as const)(
    "rejects a wrong-protocol %s before the remote request",
    async (operation) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      const storage = standaloneStorage({
        baseUrl: "https://repo.example.com",
        protocol: "s3",
      });

      await expect(
        storage[operation]({
          storageUri: "r2://updates/bundle.zip",
        }),
      ).rejects.toThrow("Expected s3, got r2");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "s3://updates/releases/../bundle.zip",
    "s3://updates/releases/bundle.zip?version=1",
    "s3://updates/releases/raw space.zip",
  ])(
    "rejects a non-canonical input URI before remote %s",
    async (storageUri) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      const storage = standaloneStorage({
        baseUrl: "https://repo.example.com",
        protocol: "s3",
      });

      await expect(storage.get({ storageUri })).rejects.toThrow(
        "Invalid storage URI",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-canonical PUT result URI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ storageUri: "s3://updates/releases/../bundle.zip" }),
      ),
    );
    const storage = standaloneStorage({
      baseUrl: "https://repo.example.com",
      protocol: "s3",
    });

    await expect(
      storage.put({
        key: "bundle.zip",
        body: new Blob(["bundle"]).stream(),
        contentType: "application/zip",
      }),
    ).rejects.toThrow("Invalid storage URI");
  });
});
