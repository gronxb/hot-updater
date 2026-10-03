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
            downloadPath: "index.ios.bundle",
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            downloadPath: "assets/logo.png",
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
            downloadPath: "index.ios.bundle",
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            downloadPath: "assets/logo.png",
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

  it("preserves patch download metadata for manifest diff files", async () => {
    const store = await importStore();
    const emitProgress = listeners.get("onProgress");

    emitProgress?.({
      artifactType: "diff",
      details: {
        completedFilesCount: 0,
        files: [
          {
            downloadPath: "index.ios.bundle.bsdiff",
            order: 0,
            path: "index.ios.bundle",
            progress: 0.4,
            status: "downloading",
          },
        ],
        totalFilesCount: 1,
      },
      progress: 0.32,
    });

    expect(store.getSnapshot().details?.files).toEqual([
      {
        downloadPath: "index.ios.bundle.bsdiff",
        downloadedBytes: undefined,
        order: 0,
        path: "index.ios.bundle",
        progress: 0.4,
        status: "downloading",
        totalBytes: undefined,
      },
    ]);
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
            downloadPath: "index.ios.bundle",
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            downloadPath: "assets/logo.png",
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
            downloadPath: "index.ios.bundle",
            order: 0,
            path: "index.ios.bundle",
            progress: 1,
            status: "downloaded",
          },
          {
            downloadPath: "assets/logo.png",
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
});
