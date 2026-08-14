import { describe, expect, it, vi } from "vitest";

import { resetProviderAfterReady } from "./provider-reset-retry.ts";

describe("provider reset after readiness", () => {
  it("retries a connection reset without hiding the successful reset", async () => {
    const connectionReset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const reset = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: connectionReset }),
      )
      .mockResolvedValueOnce();
    const wait = vi.fn(async () => {});
    const onRetry = vi.fn();

    await expect(
      resetProviderAfterReady(reset, { onRetry, wait }),
    ).resolves.toBeUndefined();

    expect(reset).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      error: expect.objectContaining({ message: "fetch failed" }),
      retryDelayMs: 1_000,
    });
  });

  it("does not retry semantic provider failures", async () => {
    const failure = new Error("Release catalog generation is inconsistent");
    const reset = vi.fn(async () => {
      throw failure;
    });
    const wait = vi.fn(async () => {});

    await expect(resetProviderAfterReady(reset, { wait })).rejects.toBe(
      failure,
    );

    expect(reset).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails after the bounded connection-reset attempts", async () => {
    const failure = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const reset = vi.fn(async () => {
      throw failure;
    });
    const wait = vi.fn(async () => {});

    await expect(resetProviderAfterReady(reset, { wait })).rejects.toBe(
      failure,
    );

    expect(reset).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
