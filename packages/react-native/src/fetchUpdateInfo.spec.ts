import type { AppUpdateInfo } from "@hot-updater/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchUpdateInfo } from "./fetchUpdateInfo";

const updateInfo: AppUpdateInfo = {
  id: "bundle-id",
  fileUrl: "https://example.com/bundle.zip",
  fileHash: null,
  shouldForceUpdate: false,
  message: null,
  status: "UPDATE",
};

const createResponse = ({
  status = 200,
  statusText = "OK",
  body = updateInfo,
}: {
  status?: number;
  statusText?: string;
  body?: AppUpdateInfo | null;
} = {}) =>
  ({
    status,
    statusText,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response;

describe("fetchUpdateInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns update info from the response body", async () => {
    const response = createResponse();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUpdateInfo({
        url: "https://updates.example.com/check-update",
        requestHeaders: {
          Authorization: "Bearer token",
        },
        requestTimeout: 1000,
      }),
    ).resolves.toEqual(updateInfo);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://updates.example.com/check-update",
      {
        signal: expect.any(AbortSignal),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
      },
    );
    expect(response.json).toHaveBeenCalledWith();
  });

  it("retries once when fetch returns no response", async () => {
    const response = createResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(undefined as unknown as Response)
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUpdateInfo({
        url: "https://updates.example.com/check-update",
      }),
    ).resolves.toEqual(updateInfo);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when fetch still returns no response after retry", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(undefined as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUpdateInfo({
        url: "https://updates.example.com/check-update",
      }),
    ).rejects.toThrow("Fetch returned no response");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the response status text for non-200 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createResponse({
          status: 500,
          statusText: "Internal Server Error",
        }),
      ),
    );

    await expect(
      fetchUpdateInfo({
        url: "https://updates.example.com/check-update",
      }),
    ).rejects.toThrow("Internal Server Error");
  });

  it("throws a timeout error when the abort signal fires", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = expect(
      fetchUpdateInfo({
        url: "https://updates.example.com/check-update",
        requestTimeout: 100,
      }),
    ).rejects.toThrow("Request timed out");

    await vi.advanceTimersByTimeAsync(100);
    await result;
  });
});
