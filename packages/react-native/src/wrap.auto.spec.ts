// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getBundleId: vi.fn(() => "bundle-id"),
  notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
  reload: vi.fn(),
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  getBundleId: mocks.getBundleId,
  notifyAppReady: mocks.notifyAppReady,
  reload: mocks.reload,
}));

describe("HotUpdater wrap automatic updates", () => {
  let runNextFrame: () => void = () => {};

  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: (time: number) => void) => {
        runNextFrame = () => callback(0);
        return 1;
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("stages an update only after native notifyAppReady has returned", async () => {
    const updateBundle = vi.fn().mockResolvedValue(true);
    mocks.checkForUpdate.mockResolvedValue({
      id: "next-bundle-id",
      message: null,
      shouldForceUpdate: false,
      status: "UPDATE",
      updateBundle,
    });
    const { wrap } = await import("./wrap");
    const App = wrap({
      resolver: { checkUpdate: vi.fn() },
      updateMode: "auto",
      updateStrategy: "appVersion",
    })(() => null);

    render(createElement(App));

    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mocks.notifyAppReady).not.toHaveBeenCalled();
    expect(updateBundle).not.toHaveBeenCalled();

    runNextFrame();

    await waitFor(() => expect(updateBundle).toHaveBeenCalledTimes(1));
    expect(mocks.notifyAppReady.mock.invocationCallOrder[0]).toBeLessThan(
      updateBundle.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
