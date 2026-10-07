// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterProgressEvent } from "./native";
import type {
  HotUpdaterFallbackComponentProps,
  InternalWrapOptions,
} from "./wrap";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: HotUpdaterProgressEvent) => void>(),
  checkForUpdate: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("./native", () => ({
  addListener: vi.fn(
    (eventName: string, listener: (event: HotUpdaterProgressEvent) => void) => {
      mocks.listeners.set(eventName, listener);
      return () => {
        mocks.listeners.delete(eventName);
      };
    },
  ),
  getUpdateId: vi.fn(() => "release-id"),
  reload: mocks.reload,
}));

describe("HotUpdater wrap progress subscription", () => {
  let frameCallbacks: ((timestamp: number) => void)[];

  const flushFrames = async () => {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (frameCallbacks.length > 0) {
        frameCallbacks.shift()?.(0);
      }
    });
  };

  const emitProgress = async (progress: number) => {
    const event: HotUpdaterProgressEvent = {
      artifactType: "diff",
      progress,
      details: {
        totalFilesCount: 1,
        completedFilesCount: progress === 1 ? 1 : 0,
        files: [
          {
            order: 0,
            path: "index.bundle",
            downloadPath: "index.bundle",
            downloadedBytes: progress * 1_000,
            totalBytes: 1_000,
            progress,
            status: progress === 1 ? "downloaded" : "downloading",
          },
        ],
      },
    };
    await act(async () => {
      mocks.listeners.get("onProgress")?.(event);
    });
    await flushFrames();
    return event;
  };

  const renderWrapped = async (
    options: Pick<
      InternalWrapOptions,
      "fallbackComponent" | "onProgress" | "onUpdateProcessCompleted"
    >,
    onRender: () => void,
  ) => {
    const { wrap } = await import("./wrap");
    const App = () => {
      onRender();
      return createElement("div", null, "app");
    };
    const Wrapped = wrap({
      checkForUpdate: mocks.checkForUpdate,
      appReady: async () => undefined,
      onError: vi.fn(),
      updateStrategy: "appVersion",
      ...options,
    })(App);

    render(createElement(Wrapped));
    await flushFrames();
  };

  beforeEach(() => {
    vi.resetModules();
    mocks.listeners.clear();
    mocks.checkForUpdate.mockReset();
    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.reload.mockReset();
    frameCallbacks = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: (timestamp: number) => void) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not re-render the wrapped app on progress updates without fallbackComponent or onProgress", async () => {
    const onRender = vi.fn();
    await renderWrapped({}, onRender);
    const rendersBeforeDownload = onRender.mock.calls.length;

    for (const progress of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      await emitProgress(progress);
    }

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeDownload);
  });

  it("keeps reporting progress to onProgress without re-rendering the wrapped app", async () => {
    const onRender = vi.fn();
    const onProgress = vi.fn();
    await renderWrapped({ onProgress }, onRender);
    const rendersBeforeDownload = onRender.mock.calls.length;

    await emitProgress(0.25);
    await emitProgress(0.75);

    expect(onProgress.mock.calls).toEqual([[0], [0.25], [0.75]]);
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeDownload);
  });

  it("keeps passing progress details to fallbackComponent during an update check", async () => {
    mocks.checkForUpdate.mockReturnValue(new Promise(() => {}));
    const fallbackProps = vi.fn();
    const Fallback = (props: HotUpdaterFallbackComponentProps) => {
      fallbackProps(props);
      return createElement("div", null, `progress:${props.progress}`);
    };
    await renderWrapped({ fallbackComponent: Fallback }, vi.fn());

    const event = await emitProgress(0.5);

    expect(screen.getByText("progress:0.5")).toBeTruthy();
    expect(fallbackProps).toHaveBeenLastCalledWith({
      ...event,
      status: "CHECK_FOR_UPDATE",
      message: null,
    });
  });

  it.each([false, true])(
    "preserves progress reporting across the fallback transition with shouldForceUpdate=%s",
    async (shouldForceUpdate) => {
      let resolveCheck!: (update: unknown) => void;
      mocks.checkForUpdate.mockReturnValue(
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
      );
      let finishDownload!: (success: boolean) => void;
      const download = new Promise<boolean>((resolve) => {
        finishDownload = resolve;
      });
      const updateBundle = vi.fn(() => download);
      const onProgress = vi.fn();
      const onRender = vi.fn();
      const onUpdateProcessCompleted = vi.fn();
      const Fallback = ({
        status,
        progress,
      }: HotUpdaterFallbackComponentProps) =>
        createElement("div", null, `${status}:${progress}`);
      await renderWrapped(
        { fallbackComponent: Fallback, onProgress, onUpdateProcessCompleted },
        onRender,
      );
      expect(screen.getByText("CHECK_FOR_UPDATE:0")).toBeTruthy();
      expect(onRender).not.toHaveBeenCalled();

      const update = {
        id: "new-release",
        status: "UPDATE",
        shouldForceUpdate,
        message: "New release",
      };
      await act(async () => {
        resolveCheck({ ...update, updateBundle });
      });
      expect(updateBundle).toHaveBeenCalledOnce();
      expect(onUpdateProcessCompleted).toHaveBeenCalledTimes(
        shouldForceUpdate ? 0 : 1,
      );
      expect(
        screen.getByText(shouldForceUpdate ? "UPDATING:0" : "app"),
      ).toBeTruthy();
      const rendersDuringDownload = onRender.mock.calls.length;

      for (const progress of [0.25, 0.75, 1]) {
        await emitProgress(progress);
      }
      expect(onRender).toHaveBeenCalledTimes(rendersDuringDownload);
      if (shouldForceUpdate) {
        expect(screen.getByText("UPDATING:1")).toBeTruthy();
      }

      await act(async () => {
        finishDownload(true);
      });
      expect(screen.getByText("app")).toBeTruthy();
      expect(onRender).toHaveBeenCalledOnce();
      expect(onUpdateProcessCompleted).toHaveBeenCalledOnce();
      expect(onUpdateProcessCompleted).toHaveBeenCalledWith(update);
      expect(mocks.reload).toHaveBeenCalledTimes(shouldForceUpdate ? 1 : 0);
      expect(onProgress.mock.calls).toEqual([[0], [0.25], [0.75], [1]]);
    },
  );
});
