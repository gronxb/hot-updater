// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { act, createElement, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("hotUpdaterStore notification scheduling", () => {
  beforeEach(() => {
    listeners.clear();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps progress notifications from exceeding React's maximum update depth", async () => {
    // Given
    const frameCallbacks: ((timestamp: number) => void)[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: (timestamp: number) => void) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
    );
    const { hotUpdaterStore } = await import("./store");
    const emitProgress = listeners.get("onProgress");
    const Consumer = () => {
      const [progress, setProgress] = useState(0);

      useLayoutEffect(() => {
        const unsubscribe = hotUpdaterStore.subscribe(() => {
          setProgress(hotUpdaterStore.getSnapshot().progress);
        });
        return () => {
          unsubscribe();
        };
      }, []);

      useLayoutEffect(() => {
        if (progress >= 1) {
          return;
        }

        const nextProgress = Math.min(1, progress + 0.01);
        emitProgress?.({
          artifactType: "archive",
          downloadedBytes: nextProgress * 1_000_000,
          progress: nextProgress,
          totalBytes: 1_000_000,
        });
      }, [progress]);

      return null;
    };

    // When
    render(createElement(Consumer));
    for (
      let frame = 0;
      frame < 200 && hotUpdaterStore.getSnapshot().progress < 1;
      frame++
    ) {
      const frameCallback = frameCallbacks.shift();
      expect(frameCallback).toBeTypeOf("function");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await act(async () => {
        frameCallback?.(0);
      });
    }

    // Then
    expect(hotUpdaterStore.getSnapshot().progress).toBe(1);
  });
});
