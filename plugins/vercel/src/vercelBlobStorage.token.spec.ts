import { describe, expect, it, vi } from "vitest";

import { vercelBlobStorage } from "./vercelBlobStorage";

describe("vercelBlobStorage's token", () => {
  it("is read from a function on first use, and checked like a string", async () => {
    const token = vi.fn(async () => "not-a-blob-token");

    const storage = vercelBlobStorage({ token });
    expect(token).not.toHaveBeenCalled();

    await expect(
      storage.exists({ storageUri: "vercel-blob://store_abc/bundle.zip" }),
    ).rejects.toThrow(
      "vercelBlobStorage needs the store's read-write token (vercel_blob_rw_...).",
    );
    expect(token).toHaveBeenCalledTimes(1);
  });
});
