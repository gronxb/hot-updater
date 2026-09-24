// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterFallbackComponentProps,
  InternalWrapOptions,
} from "./wrap";

type HotUpdaterWrapOptions = Extract<
  InternalWrapOptions,
  { updateMode: "auto" }
>;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: Record<string, unknown>) => void>(),
  checkForUpdate: vi.fn(),
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: vi.fn(
    (eventName: string, listener: (event: Record<string, unknown>) => void) => {
      mocks.listeners.set(eventName, listener);
      return () => {
        mocks.listeners.delete(eventName);
      };
    },
  ),
  getBundleId: vi.fn(() => "bundle-id"),
  notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
  reload: vi.fn(),
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
    await act(async () => {
      mocks.listeners.get("onProgress")?.({
        artifactType: "archive",
        downloadedBytes: progress * 1_000,
        progress,
        totalBytes: 1_000,
      });
    });
    await flushFrames();
  };

  const renderWrapped = async (
    options: Pick<HotUpdaterWrapOptions, "fallbackComponent" | "onProgress">,
    onRender: () => void,
  ) => {
    const { wrap } = await import("./wrap");
    const App = () => {
      onRender();
      return createElement("div", null, "app");
    };
    const Wrapped = wrap({
      resolver: { checkUpdate: vi.fn().mockResolvedValue(null) },
      updateStrategy: "appVersion",
      updateMode: "auto",
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
    // Given
    const onRender = vi.fn();
    await renderWrapped({}, onRender);
    const rendersBeforeDownload = onRender.mock.calls.length;

    // When
    for (const progress of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      await emitProgress(progress);
    }

    // Then
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeDownload);
  });

  it("keeps reporting progress to onProgress without re-rendering the wrapped app", async () => {
    // Given
    const onRender = vi.fn();
    const onProgress = vi.fn();
    await renderWrapped({ onProgress }, onRender);
    const rendersBeforeDownload = onRender.mock.calls.length;

    // When
    await emitProgress(0.25);
    await emitProgress(0.75);

    // Then
    expect(onProgress).toHaveBeenLastCalledWith(0.75);
    expect(onProgress).toHaveBeenCalledWith(0.25);
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeDownload);
  });

  it("keeps passing progress to fallbackComponent while the update is in progress", async () => {
    // Given
    mocks.checkForUpdate.mockReturnValue(new Promise(() => {}));
    const Fallback = ({ progress }: HotUpdaterFallbackComponentProps) =>
      createElement("div", null, `progress:${progress}`);
    await renderWrapped({ fallbackComponent: Fallback }, vi.fn());

    // When
    await emitProgress(0.5);

    // Then
    expect(screen.getByText("progress:0.5")).toBeTruthy();
  });
});
