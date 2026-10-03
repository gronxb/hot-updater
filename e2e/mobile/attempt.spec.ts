import { describe, expect, it, vi } from "vitest";

import { runAttemptPhase, runtimeLaunchArguments } from "./attempt.ts";

describe("mobile attempt phases", () => {
  it("aborts an expired setup and fences its late continuation", async () => {
    const controller = new AbortController();
    const mutation = vi.fn();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation = vi.fn(async () => {
      await pending;
      controller.signal.throwIfAborted();
      mutation();
    });
    await expect(
      runAttemptPhase("setup", 5, controller, controller.signal, operation),
    ).rejects.toThrow("setup timed out");
    finish();
    await Promise.resolve();
    expect(controller.signal.aborted).toBe(true);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("propagates SDK attempt cancellation before the phase deadline", async () => {
    const controller = new AbortController();
    const sdk = new AbortController();
    const signal = AbortSignal.any([controller.signal, sdk.signal]);
    const running = runAttemptPhase(
      "scenario",
      60_000,
      controller,
      signal,
      () => new Promise(() => {}),
    );
    sdk.abort(new Error("runner interrupted"));
    await expect(running).rejects.toThrow("runner interrupted");
  });

  it("keeps the full scenario budget after setup finishes", async () => {
    const controller = new AbortController();
    await expect(
      runAttemptPhase(
        "setup",
        5,
        controller,
        controller.signal,
        async () => "ready",
      ),
    ).resolves.toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.signal.aborted).toBe(false);
    await expect(
      runAttemptPhase(
        "scenario",
        10,
        controller,
        controller.signal,
        async () => "done",
      ),
    ).resolves.toBe("done");
  });
});

it("encodes runtime URLs in native launch arguments without breaking URL punctuation", () => {
  const env = {
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
      "http://127.0.0.1:3107/e2e/runtime-config?profile=a=b",
    HOT_UPDATER_E2E_APP_BASE_URL: "http://127.0.0.1:3007/hot-updater",
  };
  expect(runtimeLaunchArguments("ios", env)).toEqual([
    "-HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    "-HOT_UPDATER_APP_BASE_URL",
    env.HOT_UPDATER_E2E_APP_BASE_URL,
  ]);
  expect(runtimeLaunchArguments("android", env)).toEqual([
    "--es",
    "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    "--es",
    "HOT_UPDATER_APP_BASE_URL",
    env.HOT_UPDATER_E2E_APP_BASE_URL,
  ]);
});
