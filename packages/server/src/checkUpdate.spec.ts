import { NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";
import {
  createCheckUpdateResponse,
  parseCheckUpdateRequest,
} from "./checkUpdate";

describe("parseCheckUpdateRequest", () => {
  it("parses app-version requests from legacy headers", () => {
    const request = new Request("https://example.com/api/check-update", {
      headers: {
        "x-app-platform": "ios",
        "x-app-version": "1.0.0",
        "x-bundle-id": "bundle-id",
      },
    });

    const result = parseCheckUpdateRequest(request);

    expect(result).toEqual({
      ok: true,
      args: {
        platform: "ios",
        appVersion: "1.0.0",
        bundleId: "bundle-id",
        minBundleId: NIL_UUID,
        channel: "production",
        cohort: undefined,
        _updateStrategy: "appVersion",
      },
    });
  });

  it("parses fingerprint requests from legacy headers", () => {
    const request = new Request("https://example.com/api/check-update", {
      headers: {
        "x-app-platform": "android",
        "x-fingerprint-hash": "fp-hash",
        "x-bundle-id": "bundle-id",
        "x-min-bundle-id": "min-bundle-id",
        "x-channel": "beta",
        "x-cohort": "20",
      },
    });

    const result = parseCheckUpdateRequest(request);

    expect(result).toEqual({
      ok: true,
      args: {
        platform: "android",
        fingerprintHash: "fp-hash",
        bundleId: "bundle-id",
        minBundleId: "min-bundle-id",
        channel: "beta",
        cohort: "20",
        _updateStrategy: "fingerprint",
      },
    });
  });

  it("returns 400 when required headers are missing", async () => {
    const request = new Request("https://example.com/api/check-update");

    const result = parseCheckUpdateRequest(request);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
  });
});

describe("createCheckUpdateResponse", () => {
  it("delegates to hotUpdater.getAppUpdateInfo", async () => {
    const getAppUpdateInfo = vi.fn().mockResolvedValue({
      id: NIL_UUID,
      message: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      fileHash: null,
      fileUrl: null,
    });
    const request = new Request("https://example.com/api/check-update", {
      headers: {
        "x-app-platform": "ios",
        "x-app-version": "1.0.0",
        "x-bundle-id": "bundle-id",
      },
    });

    const response = await createCheckUpdateResponse(
      { getAppUpdateInfo },
      request,
    );

    expect(getAppUpdateInfo).toHaveBeenCalledWith({
      platform: "ios",
      appVersion: "1.0.0",
      bundleId: "bundle-id",
      minBundleId: NIL_UUID,
      channel: "production",
      cohort: undefined,
      _updateStrategy: "appVersion",
    });
    await expect(response.json()).resolves.toEqual({
      id: NIL_UUID,
      message: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      fileHash: null,
      fileUrl: null,
    });
  });
});
