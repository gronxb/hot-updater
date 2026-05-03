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

const importStore = async () => {
  const { hotUpdaterStore } = await import("./store");
  return hotUpdaterStore;
};

describe("hotUpdaterStore", () => {
  beforeEach(() => {
    listeners.clear();
    vi.resetModules();
  });

  it("does not notify subscribers when state values are unchanged", async () => {
    const store = await importStore();
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);

    store.setState({});
    store.setState({ progress: 0 });
    store.setState({ isUpdateDownloaded: false });

    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("notifies subscribers only when progress events change the snapshot", async () => {
    const store = await importStore();
    const listener = vi.fn();
    const emitProgress = listeners.get("onProgress");

    expect(emitProgress).toBeTypeOf("function");

    const unsubscribe = store.subscribe(listener);

    emitProgress?.({
      artifactType: "archive",
      progress: 0.5,
    });
    emitProgress?.({
      artifactType: "archive",
      progress: 0.5,
    });
    emitProgress?.({
      artifactType: "archive",
      progress: 1,
    });
    store.setState({ isUpdateDownloaded: true });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({
      artifactType: "archive",
      details: null,
      downloadedBytes: undefined,
      isUpdateDownloaded: true,
      progress: 1,
      totalBytes: undefined,
    });

    unsubscribe();
  });

  it("stores archive byte metadata and notifies when only bytes change", async () => {
    const store = await importStore();
    const listener = vi.fn();
    const emitProgress = listeners.get("onProgress");

    const unsubscribe = store.subscribe(listener);

    emitProgress?.({
      artifactType: "archive",
      downloadedBytes: 100.4,
      progress: 0.5,
      totalBytes: 1_000,
    });
    emitProgress?.({
      artifactType: "archive",
      downloadedBytes: 250,
      progress: 0.5,
      totalBytes: 1_000,
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({
      artifactType: "archive",
      details: null,
      downloadedBytes: 250,
      isUpdateDownloaded: false,
      progress: 0.5,
      totalBytes: 1_000,
    });

    unsubscribe();
  });

  it("stores manifest progress metadata while keeping overall progress", async () => {
    const store = await importStore();
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

    expect(store.getSnapshot()).toEqual({
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
      downloadedBytes: undefined,
      isUpdateDownloaded: false,
      progress: 0.42,
      totalBytes: undefined,
    });
  });

  it("stores diff snapshot transitions from downloading to downloaded", async () => {
    const store = await importStore();
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

    expect(store.getSnapshot()).toEqual({
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
      downloadedBytes: undefined,
      isUpdateDownloaded: false,
      progress: 0.6,
      totalBytes: undefined,
    });
  });

  it("clears manifest metadata when archive progress events arrive", async () => {
    const store = await importStore();
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

    expect(store.getSnapshot()).toEqual({
      artifactType: "archive",
      details: null,
      downloadedBytes: undefined,
      isUpdateDownloaded: false,
      progress: 0.25,
      totalBytes: undefined,
    });
  });

  it("clears stale manifest metadata even when archive events omit optional fields", async () => {
    const store = await importStore();
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

    expect(store.getSnapshot()).toEqual({
      artifactType: "archive",
      details: null,
      downloadedBytes: undefined,
      isUpdateDownloaded: false,
      progress: 0.4,
      totalBytes: undefined,
    });
  });
});
