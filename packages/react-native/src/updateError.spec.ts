import { describe, expect, it } from "vitest";

import { StaleReleaseCatalogError } from "./error";
import { FetchJSONResponseError } from "./fetchJSON";
import {
  classifyUpdateError,
  InvalidUpdateResponseError,
  UpdateHttpError,
} from "./updateError";

const nativeRejection = (userInfo?: Record<string, unknown>) =>
  Object.assign(new Error("native failure"), {
    code: "DOWNLOAD_FAILED",
    ...(userInfo === undefined ? {} : { userInfo }),
  });

describe("classifyUpdateError", () => {
  it.each([
    {
      label: "an HTTP status",
      error: new UpdateHttpError(503, "Service Unavailable"),
      expected: { reason: "http", httpStatus: 503 },
    },
    {
      label: "a JSON request's HTTP status",
      error: new FetchJSONResponseError(404, "Not Found"),
      expected: { reason: "http", httpStatus: 404 },
    },
    {
      label: "fetch without a response",
      error: new TypeError("Network request failed"),
      expected: { reason: "network" },
    },
    {
      label: "a timeout",
      error: new Error("Request timed out"),
      expected: { reason: "network", transport: "timeout" },
    },
    {
      label: "a cancelled request",
      error: Object.assign(new Error("aborted"), { name: "AbortError" }),
      expected: { reason: "network", transport: "cancelled" },
    },
    {
      // As a device on Expo 58 reported it from production.
      label: "Expo's canceled fetch on iOS",
      error: new Error(
        "fetch failed: FetchRequestCanceledException: Fetch request has been canceled (at Expo/NativeResponse.swift:63)",
      ),
      expected: { reason: "network", transport: "cancelled" },
    },
    {
      label: "Expo's canceled fetch on Android",
      error: new Error("fetch failed: Fetch request has been canceled"),
      expected: { reason: "network", transport: "cancelled" },
    },
    {
      label: "Expo's fetch without a response",
      error: new Error(
        "fetch failed: FetchUnknownException: Unknown error (at Expo/NativeResponse.swift:198)",
      ),
      expected: { reason: "network" },
    },
    {
      label: "an invalid response",
      error: new InvalidUpdateResponseError(
        "Received an invalid Release catalog",
      ),
      expected: { reason: "invalid_response" },
    },
    {
      label: "unparsable JSON",
      error: new SyntaxError("Unexpected token"),
      expected: { reason: "invalid_response" },
    },
    {
      label: "anything else",
      error: new Error("Fingerprint hash is required"),
      expected: { reason: "unknown" },
    },
  ])("classifies $label in the stage it happened", ({ error, expected }) => {
    expect(classifyUpdateError(error, "check", "catalog")).toEqual({
      stage: "check",
      resource: "catalog",
      ...expected,
    });
  });

  it("leaves out the resource when the caller names none", () => {
    expect(classifyUpdateError(new Error("unexpected"), "download")).toEqual({
      stage: "download",
      reason: "unknown",
    });
  });

  it("takes a native rejection's own classification", () => {
    expect(
      classifyUpdateError(
        nativeRejection({
          reason: "patch",
          resource: "patch",
          stage: "install",
        }),
        "download",
        "artifact",
      ),
    ).toEqual({ stage: "install", reason: "patch", resource: "patch" });
    expect(
      classifyUpdateError(
        nativeRejection({
          httpStatus: 403,
          originCode: "AccessDenied",
          reason: "http",
          resource: "file",
          stage: "download",
        }),
        "download",
      ),
    ).toEqual({
      stage: "download",
      reason: "http",
      resource: "file",
      httpStatus: 403,
      originCode: "AccessDenied",
    });
    expect(
      classifyUpdateError(
        nativeRejection({
          reason: "network",
          stage: "download",
          transport: "dns",
        }),
        "download",
      ),
    ).toEqual({ stage: "download", reason: "network", transport: "dns" });
  });

  it("drops native details that do not fit their field", () => {
    expect(
      classifyUpdateError(
        nativeRejection({
          httpStatus: 403,
          originCode: "Access Denied <Key>secret</Key>",
          reason: "http",
          resource: "bucket",
          stage: "download",
          transport: "timeout",
        }),
        "download",
      ),
    ).toEqual({ stage: "download", reason: "http", httpStatus: 403 });
  });

  it.each([
    { label: "a stale selection", error: new StaleReleaseCatalogError() },
    { label: "an unclassified native rejection", error: nativeRejection() },
    {
      label: "a native rejection with an unknown class",
      error: nativeRejection({ reason: "cosmic", stage: "download" }),
    },
  ])("reports $label as no update failure", ({ error }) => {
    expect(classifyUpdateError(error, "download")).toBeNull();
  });
});
