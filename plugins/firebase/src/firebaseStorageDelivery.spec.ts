import { describe, expect, it, vi } from "vitest";

import { firebaseStorageDelivery } from "./firebaseStorageDelivery";

const { file, getStorage } = vi.hoisted(() => {
  const file = { getSignedUrl: vi.fn() };
  return {
    file,
    getStorage: vi.fn(() => ({
      bucket: vi.fn(() => ({ file: vi.fn(() => file) })),
    })),
  };
});

vi.mock("firebase-admin/app", () => ({
  getApp: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(() => ({})),
}));
vi.mock("firebase-admin/storage", () => ({ getStorage }));

describe("firebaseStorageDelivery", () => {
  it("resolves CDN URLs outside the storage plugin", async () => {
    const delivery = firebaseStorageDelivery({
      cdnUrl: "https://cdn.example.com/",
      projectId: "project",
      storageBucket: "updates",
    });

    await expect(
      delivery.resolveUrl("gs://updates/releases/bundle.zip"),
    ).resolves.toBe("https://cdn.example.com/releases/bundle.zip");
    expect(file.getSignedUrl).not.toHaveBeenCalled();
  });
});
