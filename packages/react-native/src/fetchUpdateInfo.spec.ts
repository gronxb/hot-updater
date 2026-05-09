import type { AppUpdateInfo } from "@hot-updater/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchUpdateInfo } from "./fetchUpdateInfo";

const updateInfo: AppUpdateInfo = {
  fileHash: "hash",
  fileUrl: "https://example.com/bundle.zip",
  id: "bundle-id",
  message: "update",
  shouldForceUpdate: false,
  status: "UPDATE",
};

const createResponse = ({
  body,
  status = 200,
  statusText = "OK",
}: {
  body: string;
  status?: number;
  statusText?: string;
}) =>
  ({
    json: vi.fn(async () => {
      throw new Error("json parser should not be used");
    }),
    status,
    statusText,
    text: vi.fn(async () => body),
  }) as unknown as Response;

describe("fetchUpdateInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses update info from response text instead of response.json", async () => {
    const response = createResponse({ body: JSON.stringify(updateInfo) });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUpdateInfo({
        requestHeaders: { authorization: "Bearer token" },
        requestTimeout: 1500,
        url: "https://example.com/check-update",
      }),
    ).resolves.toEqual(updateInfo);

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/check-update", {
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer token",
      },
      signal: expect.any(AbortSignal),
    });
    expect(response.text).toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it("returns null for null update responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createResponse({ body: "null" })),
    );

    await expect(
      fetchUpdateInfo({ url: "https://example.com/check-update" }),
    ).resolves.toBeNull();
  });

  it("returns null for empty update responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createResponse({ body: "  " })),
    );

    await expect(
      fetchUpdateInfo({ url: "https://example.com/check-update" }),
    ).resolves.toBeNull();
  });

  it("throws non-200 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createResponse({
          body: "not found",
          status: 404,
          statusText: "Not Found",
        }),
      ),
    );

    await expect(
      fetchUpdateInfo({ url: "https://example.com/check-update" }),
    ).rejects.toThrow("Not Found");
  });
});
