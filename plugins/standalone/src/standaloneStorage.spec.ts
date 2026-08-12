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
      return Response.json({ storageUri: "http://localhost/bundle.zip" });
    });
    vi.stubGlobal("fetch", fetch);
    const storage = standaloneStorage({ baseUrl: "http://localhost" });

    await expect(
      storage.put({
        key: "bundle-id/bundle.zip",
        body: new TextEncoder().encode("bundle"),
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "http://localhost/bundle.zip",
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
    const storage = standaloneStorage({ baseUrl: "http://localhost" });

    await expect(storage.exists("http://localhost/bundle.zip")).resolves.toBe(
      true,
    );
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
    const storage = standaloneStorage({ baseUrl: "http://localhost" });

    const response = await storage.get("http://localhost/bundle.zip");

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
    const storage = standaloneStorage({ baseUrl: "http://localhost" });

    await storage.delete("https://cdn.example.com/bundle.zip");

    expect(fetch).toHaveBeenCalledOnce();
  });
});
