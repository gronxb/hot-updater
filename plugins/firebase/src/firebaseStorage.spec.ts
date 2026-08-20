import { beforeEach, describe, expect, it, vi } from "vitest";

import { firebaseFunctionsStorage } from "./firebaseFunctionsStorage";
import { firebaseStorage } from "./firebaseStorage";

const { bucket, file, getStorage } = vi.hoisted(() => {
  const file = {
    getSignedUrl: vi.fn(),
  };
  const bucket = {
    file: vi.fn(() => file),
  };

  return {
    bucket,
    file,
    getStorage: vi.fn(() => ({ bucket: vi.fn(() => bucket) })),
  };
});

vi.mock("firebase-admin/app", () => ({
  getApp: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(() => ({})),
}));

vi.mock("firebase-admin/storage", () => ({ getStorage }));

describe("firebaseStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decodes percent-encoded object keys before signing", async () => {
    file.getSignedUrl.mockResolvedValueOnce([
      "https://storage.googleapis.com/updates/signed",
    ]);
    const storage = firebaseStorage({
      projectId: "project",
      storageBucket: "updates",
    })();

    await storage.profiles.runtime.getDownloadUrl(
      "gs://updates/assets/bootsplash/logo-ios%402x.png",
    );

    expect(bucket.file).toHaveBeenCalledWith(
      "assets/bootsplash/logo-ios@2x.png",
    );
  });

  it("keeps object keys encoded in CDN HTTP URLs", async () => {
    const storage = firebaseFunctionsStorage({
      cdnUrl: "https://cdn.example.com/downloads/",
      projectId: "project",
      storageBucket: "updates",
    })();

    await expect(
      storage.profiles.runtime.getDownloadUrl(
        "gs://updates/assets/bootsplash/logo-ios%402x.png",
      ),
    ).resolves.toEqual({
      fileUrl:
        "https://cdn.example.com/downloads/assets/bootsplash/logo-ios%402x.png",
    });
  });
});
