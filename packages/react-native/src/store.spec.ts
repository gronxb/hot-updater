import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(
  () => new Map<string, (event: Record<string, unknown>) => void>(),
);

vi.mock("./native", () => ({
  addListener: vi.fn(
    (eventName: string, listener: (event: Record<string, unknown>) => void) => {
      listeners.set(eventName, listener);
      return () => {
        listeners.delete(eventName);
      };
    },
  ),
}));

describe("hotUpdaterStore", () => {
  beforeEach(() => {
    listeners.clear();
    vi.resetModules();
  });

  it("stores manifest progress metadata while keeping overall progress", async () => {
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");

    expect(emitProgress).toBeTypeOf("function");

    emitProgress?.({
      artifactType: "diff",
      details: {
        completedFilesCount: 1,
        files: [
          {
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            order: 1,
            path: "assets/logo.png",
            progress: 0.5,
            status: "downloading",
          },
        ],
        totalFilesCount: 2,
      },
      progress: 0.42,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: "diff",
      details: {
        completedFilesCount: 1,
        files: [
          {
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            order: 1,
            path: "assets/logo.png",
            progress: 0.5,
            status: "downloading",
          },
        ],
        totalFilesCount: 2,
      },
      isUpdateDownloaded: false,
      progress: 0.42,
    });
  });

  it("stores diff snapshot transitions from downloading to downloaded", async () => {
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");

    emitProgress?.({
      artifactType: "diff",
      details: {
        completedFilesCount: 0,
        files: [
          {
            order: 0,
            path: "index.ios.bundle",
            progress: 0.6,
            status: "downloading",
          },
          {
            order: 1,
            path: "assets/logo.png",
            progress: 0,
            status: "pending",
          },
        ],
        totalFilesCount: 2,
      },
      progress: 0.4,
    });

    emitProgress?.({
      artifactType: "diff",
      details: {
        completedFilesCount: 1,
        files: [
          {
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            order: 1,
            path: "assets/logo.png",
            progress: 0,
            status: "pending",
          },
        ],
        totalFilesCount: 2,
      },
      progress: 0.6,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: "diff",
      details: {
        completedFilesCount: 1,
        files: [
          {
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            order: 1,
            path: "assets/logo.png",
            progress: 0,
            status: "pending",
          },
        ],
        totalFilesCount: 2,
      },
      isUpdateDownloaded: false,
      progress: 0.6,
    });
  });

  it("clears manifest metadata when archive progress events arrive", async () => {
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");

    emitProgress?.({
      artifactType: "diff",
      details: {
        completedFilesCount: 2,
        files: [
          {
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            order: 1,
            path: "assets/logo.png",
            progress: 1,
            status: "downloaded",
          },
          {
            order: 2,
            path: "assets/bg.png",
            progress: 0,
            status: "pending",
          },
        ],
        totalFilesCount: 3,
      },
      progress: 0.9,
    });

    emitProgress?.({
      artifactType: "archive",
      progress: 0.25,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: "archive",
      details: null,
      isUpdateDownloaded: false,
      progress: 0.25,
    });
  });

  it("clears stale manifest metadata even when archive events omit optional fields", async () => {
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");

    emitProgress?.({
      artifactType: "diff",
      details: {
        completedFilesCount: 0,
        files: [
          {
            order: 0,
            path: "manifest.asset.png",
            progress: 0,
            status: "failed",
          },
        ],
        totalFilesCount: 1,
      },
      progress: 0.2,
    });

    emitProgress?.({
      artifactType: "archive",
      progress: 0.4,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: "archive",
      details: null,
      isUpdateDownloaded: false,
      progress: 0.4,
    });
  });
});
