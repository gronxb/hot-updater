import { describe, expect, it } from "vitest";

import {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
  normalizeChannelName,
  parseReleaseCatalogScopeKey,
} from "./releaseCatalogScope";

describe("Release catalog scope identity", () => {
  it("round-trips a canonical Unicode channel without path aliases", () => {
    const channel = "프로덕션/β";
    const channelKey = encodeChannelKey(channel);

    expect(channelKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeChannelKey(channelKey)).toBe(channel);
    expect(() => decodeChannelKey(`${channelKey}=`)).toThrow(
      "Invalid channel key",
    );
  });

  it("normalizes once but rejects non-canonical stored names", () => {
    expect(normalizeChannelName("  Cafe\u0301  ")).toBe("Café");
    expect(() => encodeChannelKey("  production")).toThrow("NFC-normalized");
    expect(() => encodeChannelKey("Cafe\u0301")).toThrow("NFC-normalized");
  });

  it("derives exact scope keys without a channel lookup", () => {
    const channelKey = encodeChannelKey("production");

    expect(
      createReleaseCatalogScopeKey({
        authorityId: "project-a",
        channelKey,
        platform: "ios",
        strategy: "APP_VERSION",
      }),
    ).toBe(`v1:app-version:project-a:ios:${channelKey}`);

    expect(
      createReleaseCatalogScopeKey({
        authorityId: "project-a",
        channelKey,
        fingerprintHash: "sha256-deadbeef",
        platform: "android",
        strategy: "FINGERPRINT",
      }),
    ).toBe(`v1:fingerprint:project-a:android:${channelKey}:sha256-deadbeef`);
  });

  it("parses canonical scope keys back to their exact inputs", () => {
    const channelKey = encodeChannelKey("프로덕션/β");
    const inputs = [
      {
        authorityId: "project-a",
        channelKey,
        platform: "ios",
        strategy: "APP_VERSION",
      },
      {
        authorityId: "project-a",
        channelKey,
        fingerprintHash: "sha256-deadbeef",
        platform: "android",
        strategy: "FINGERPRINT",
      },
    ] as const;

    for (const input of inputs) {
      expect(
        parseReleaseCatalogScopeKey(createReleaseCatalogScopeKey(input)),
      ).toEqual(input);
    }
  });

  it.each([
    "",
    "v2:app-version:project-a:ios:cHJvZHVjdGlvbg",
    "v1:app-version:project-a:web:cHJvZHVjdGlvbg",
    "v1:app-version:project-a:ios",
    "v1:app-version:project-a:ios:cHJvZHVjdGlvbg:extra",
    "v1:fingerprint:project-a:ios:cHJvZHVjdGlvbg",
    "v1:fingerprint:project-a:ios:cHJvZHVjdGlvbg:",
    "v1:fingerprint:project:a:ios:cHJvZHVjdGlvbg:hash",
    "v1:app-version:project-a:ios:cHJvZHVjdGlvbg==",
  ])("rejects a malformed or non-canonical scope key: %s", (scopeKey) => {
    expect(() => parseReleaseCatalogScopeKey(scopeKey)).toThrow();
  });

  it("bounds scope segments to printable ASCII that fits provider keys", () => {
    const channelKey = encodeChannelKey("production");
    const createScope = (authorityId: string, fingerprintHash = "hash") =>
      createReleaseCatalogScopeKey({
        authorityId,
        channelKey,
        fingerprintHash,
        platform: "android",
        strategy: "FINGERPRINT",
      });

    expect(createScope("a".repeat(255), "f".repeat(255))).toHaveLength(549);
    expect(() => createScope("a".repeat(256))).toThrow("1-255");
    expect(() => createScope("project:one")).toThrow("URL-safe ASCII");
    expect(() => createScope("project/one")).toThrow("URL-safe ASCII");
    expect(() => createScope("project-한글")).toThrow("URL-safe ASCII");
    expect(() => createScope("project", "f".repeat(256))).toThrow("1-255");
  });
});
