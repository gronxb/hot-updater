import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { standaloneStorage } from "./standaloneStorage";

describe("standaloneStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the upload hook before resolving", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "hot-updater-"));
    const filePath = path.join(tempDir, "bundle.zip");
    await writeFile(filePath, "bundle");
    let hookDone = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ storageUri: "http://localhost/bundle.zip" }),
          {
            status: 200,
          },
        );
      }),
    );

    const storage = standaloneStorage(
      {
        baseUrl: "http://localhost",
      },
      {
        onStorageUploaded: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                hookDone = true;
                resolve();
              }, 10);
            }),
        ),
      },
    )();

    try {
      await expect(
        storage.profiles.node.upload("bundle-id", filePath),
      ).resolves.toEqual({
        storageUri: "http://localhost/bundle.zip",
      });
      expect(hookDone).toBe(true);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("checks object existence with the resolved download URL", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === "http://localhost/getDownloadUrl") {
        return new Response(
          JSON.stringify({ fileUrl: "https://cdn.example.com/bundle.zip" }),
          { status: 200 },
        );
      }

      expect(String(input)).toBe("https://cdn.example.com/bundle.zip");
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const storage = standaloneStorage({
      baseUrl: "http://localhost",
    })();

    await expect(
      storage.profiles.node.exists("http://localhost/bundle.zip"),
    ).resolves.toBe(true);
  });
});
