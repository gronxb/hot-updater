import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ios-devices-rpc", () => ({}));

import { keepIosDeviceReceipt } from "./ios-devices-api";
import {
  holdPendingReceipt,
  IOS_DEVICE_PENDING_RECEIPT_KEY,
  readPendingReceipt,
} from "./native-builds";

const ok = () =>
  new Response(JSON.stringify({ udid: "phone" }), { status: 200 });

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("trading the profile's receipt for the cookie", () => {
  // The adversarial review's repro, as written.
  it("retries a failed exchange when the connection recovers", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetcher);
    await keepIosDeviceReceipt("", "valid-fragment-receipt").catch(() => {});
    await keepIosDeviceReceipt("", "valid-fragment-receipt").catch(() => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries after a 503, and trades a receipt once it has succeeded", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetcher);
    await expect(keepIosDeviceReceipt("", "r-503")).rejects.toThrow();
    await keepIosDeviceReceipt("", "r-503");
    await keepIosDeviceReceipt("", "r-503");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares one request between callers while it is in flight", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = keepIosDeviceReceipt("", "r-flight");
    const second = keepIosDeviceReceipt("", "r-flight");
    finish(ok());
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("holds the receipt in this tab's session until the trade succeeds, then drops it", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetcher);
    holdPendingReceipt("phone", "r-session");
    await keepIosDeviceReceipt("", "r-session").catch(() => {});
    expect(
      window.sessionStorage.getItem(IOS_DEVICE_PENDING_RECEIPT_KEY),
    ).not.toBeNull();
    await keepIosDeviceReceipt("", "r-session");
    expect(window.sessionStorage.getItem(IOS_DEVICE_PENDING_RECEIPT_KEY)).toBe(
      null,
    );
  });

  it("forgets a held receipt once it has expired", () => {
    const token = (x: number) =>
      `${btoa(JSON.stringify({ u: "phone", x })).replaceAll("=", "")}.sig`;
    const fresh = token(Date.now() + 60_000);
    holdPendingReceipt("phone", fresh);
    expect(readPendingReceipt("phone")).toBe(fresh);
    expect(readPendingReceipt("other")).toBeNull();
    holdPendingReceipt("phone", token(Date.now() - 1));
    expect(readPendingReceipt("phone")).toBeNull();
    expect(
      window.sessionStorage.getItem(IOS_DEVICE_PENDING_RECEIPT_KEY),
    ).toBeNull();
  });
});
