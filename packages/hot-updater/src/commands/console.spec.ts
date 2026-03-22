import { afterEach, describe, expect, it, vi } from "vitest";
import { isConsoleServerReady, waitForConsoleReady } from "./console";

describe("isConsoleServerReady", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the console server responds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(isConsoleServerReady(3_000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3000", {
      method: "HEAD",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
  });

  it("returns false when the console server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    await expect(isConsoleServerReady(3_000)).resolves.toBe(false);
  });
});

describe("waitForConsoleReady", () => {
  const child = {
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
  };

  it("waits until the readiness probe succeeds", async () => {
    const checkReady = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      waitForConsoleReady({
        child,
        port: 3_000,
        checkReady,
        pollIntervalMs: 0,
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(checkReady).toHaveBeenCalledTimes(3);
  });

  it("fails fast when the child exits before becoming ready", async () => {
    await expect(
      waitForConsoleReady({
        child: {
          exitCode: 1,
          signalCode: null,
        },
        port: 3_000,
      }),
    ).rejects.toThrow(
      "Console server exited before it became ready (exit code: 1).",
    );
  });

  it("fails when readiness never succeeds before the timeout", async () => {
    await expect(
      waitForConsoleReady({
        child,
        port: 3_000,
        timeoutMs: 0,
        checkReady: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow("Timed out waiting for the console server on port 3000.");
  });
});
