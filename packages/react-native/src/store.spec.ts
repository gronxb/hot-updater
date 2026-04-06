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
      artifactType: "manifest",
      completedFiles: 2,
      currentFilePath: "index.ios.bundle",
      currentFileProgress: 0.5,
      progress: 0.42,
      totalFiles: 4,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: "manifest",
      details: {
        completedFiles: 2,
        currentFilePath: "index.ios.bundle",
        currentFileProgress: 0.5,
        totalFiles: 4,
      },
      isUpdateDownloaded: false,
      progress: 0.42,
    });
  });

  it("clears manifest metadata when archive progress events arrive", async () => {
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");

    emitProgress?.({
      artifactType: "manifest",
      completedFiles: 3,
      currentFilePath: "assets/logo.png",
      currentFileProgress: 1,
      progress: 0.9,
      totalFiles: 5,
    });

    emitProgress?.({
      artifactType: "archive",
      completedFiles: null,
      currentFilePath: null,
      currentFileProgress: null,
      progress: 0.25,
      totalFiles: null,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: null,
      details: null,
      isUpdateDownloaded: false,
      progress: 0.25,
    });
  });

  it("clears stale manifest metadata even when archive events omit optional fields", async () => {
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");

    emitProgress?.({
      artifactType: "manifest",
      completedFiles: 1,
      currentFilePath: "manifest.json",
      currentFileProgress: 0.8,
      progress: 0.2,
      totalFiles: 3,
    });

    emitProgress?.({
      artifactType: "archive",
      progress: 0.4,
    });

    expect(hotUpdaterStore.getSnapshot()).toEqual({
      artifactType: null,
      details: null,
      isUpdateDownloaded: false,
      progress: 0.4,
    });
  });
});
