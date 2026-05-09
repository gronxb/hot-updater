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
  body = updateInfo,
  status = 200,
  statusText = "OK",
}: {
  body?: AppUpdateInfo | null;
  status?: number;
  statusText?: string;
}) =>
  ({
    json: vi.fn(async () => body),
    status,
    statusText,
  }) as unknown as Response;

describe("fetchUpdateInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses update info with response.json", async () => {
    const response = createResponse({});
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
    });
    expect(response.json).toHaveBeenCalled();
  });

  it("throws a clear error when fetch returns no response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => undefined),
    );

    await expect(
      fetchUpdateInfo({ url: "https://example.com/check-update" }),
    ).rejects.toThrow("Fetch returned no response");
  });

  it("throws non-200 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createResponse({
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
