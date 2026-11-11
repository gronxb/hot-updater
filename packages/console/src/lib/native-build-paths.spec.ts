import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import {
  nativeBuildPathKey,
  nativeBuildPathOf,
  newerBuildsOnPath,
} from "./native-build-paths";

const id = (n: number) =>
  `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const build = (
  n: number,
  overrides: Partial<NativeBuildRow> = {},
): NativeBuildRow => ({
  id: id(n),
  scope_key: "scope",
  platform: "ios",
  channel_id: `channel:${encodeChannelKey("production")}`,
  fingerprint_hash: null,
  app_version: "1.7.0",
  min_bundle_id: id(100 + n),
  artifact_kind: "ipa",
  artifact_storage_uri: `r2://bucket/native-builds/ios/${id(n)}/App.ipa`,
  byte_size: 1,
  git_commit_hash: null,
  created_at_ms: n * 1_000,
  build_key: null,
  build_number: String(n),
  submitted_to: null,
  submitted_at_ms: null,
  submitted_version: null,
  is_store_build: false,
  is_sandbox: false,
  sandbox_url_scheme: null,
  ...overrides,
});

const testflight = (n: number, overrides: Partial<NativeBuildRow> = {}) =>
  build(n, {
    submitted_to: "testflight",
    submitted_at_ms: n * 1_000,
    submitted_version: `1.7.0 (${n})`,
    ...overrides,
  });

/** The IDs `newerBuildsOnPath` passes over, each with its newer build's. */
const passedOver = (rows: readonly NativeBuildRow[]) =>
  Object.fromEntries(
    [...newerBuildsOnPath(rows)].map(([older, newer]) => [older, newer.id]),
  );

describe("nativeBuildPathOf", () => {
  it("is the store track a build went to, else its artifact", () => {
    expect(nativeBuildPathOf(testflight(1))).toBe("testflight");
    expect(
      nativeBuildPathOf(
        build(1, {
          platform: "android",
          artifact_kind: "aab",
          submitted_to: "play-closed",
        }),
      ),
    ).toBe("play-closed");
    expect(nativeBuildPathOf(build(1))).toBe("ipa");
    expect(nativeBuildPathOf(build(1, { artifact_kind: "app" }))).toBe("app");
    expect(
      nativeBuildPathOf(
        build(1, { platform: "android", artifact_kind: "apk" }),
      ),
    ).toBe("apk");
  });
});

describe("nativeBuildPathKey", () => {
  it("is the platform, channel, sandbox flag, and path, and nothing else", () => {
    const key = nativeBuildPathKey(testflight(1));
    // A target, build number, or store mark is no part of the path.
    expect(
      nativeBuildPathKey(
        testflight(2, {
          app_version: "2.0.0",
          fingerprint_hash: "f",
          is_store_build: true,
          scope_key: "other",
        }),
      ),
    ).toBe(key);
    expect(nativeBuildPathKey(testflight(1, { is_sandbox: true }))).not.toBe(
      key,
    );
    expect(
      nativeBuildPathKey(
        testflight(1, { channel_id: `channel:${encodeChannelKey("staging")}` }),
      ),
    ).not.toBe(key);
    expect(nativeBuildPathKey(build(1))).not.toBe(key);
  });
});

describe("newerBuildsOnPath", () => {
  it("passes over every older build on a path for its newest", () => {
    expect(
      passedOver([testflight(80), testflight(79), testflight(78)]),
    ).toEqual({ [id(79)]: id(80), [id(78)]: id(80) });
  });

  it("keeps one newest per path: TestFlight, an IPA, a simulator app, and each Play track", () => {
    const android = {
      platform: "android" as const,
      artifact_kind: "aab" as const,
    };
    const rows = [
      testflight(9),
      build(8),
      build(7, { artifact_kind: "app" }),
      build(6, { ...android, submitted_to: "play-internal" }),
      build(5, { ...android, submitted_to: "play-production" }),
      build(4, { ...android, artifact_kind: "apk" }),
      build(3, android),
      // One older build on each path.
      testflight(29),
      build(28),
      build(27, { artifact_kind: "app" }),
      build(26, { ...android, submitted_to: "play-internal" }),
      build(25, { ...android, submitted_to: "play-production" }),
      build(24, { ...android, artifact_kind: "apk" }),
      build(23, android),
    ];
    expect(passedOver(rows)).toEqual({
      [id(9)]: id(29),
      [id(8)]: id(28),
      [id(7)]: id(27),
      [id(6)]: id(26),
      [id(5)]: id(25),
      [id(4)]: id(24),
      [id(3)]: id(23),
    });
  });

  it("keeps sandbox builds and each channel's builds on their own paths", () => {
    const staging = `channel:${encodeChannelKey("staging")}`;
    expect(
      passedOver([
        testflight(4, { is_sandbox: true }),
        testflight(3),
        testflight(2, { channel_id: staging }),
        testflight(1, { is_sandbox: true }),
      ]),
    ).toEqual({ [id(1)]: id(4) });
  });

  it("never passes over the marked store build, which still counts as newer", () => {
    expect(
      passedOver([
        testflight(3),
        testflight(2, { is_store_build: true }),
        testflight(1),
      ]),
    ).toEqual({ [id(1)]: id(3) });
    expect(
      passedOver([testflight(3, { is_store_build: true }), testflight(2)]),
    ).toEqual({ [id(2)]: id(3) });
  });

  it("orders by the registry's server time, not the ID, then by the ID", () => {
    // The ID says build 2 is newer; the server registered build 1 later.
    expect(
      passedOver([
        testflight(2, { created_at_ms: 1_000 }),
        testflight(1, { created_at_ms: 2_000 }),
      ]),
    ).toEqual({ [id(2)]: id(1) });
    expect(
      passedOver([
        testflight(2, { created_at_ms: 1_000 }),
        testflight(1, { created_at_ms: 1_000 }),
      ]),
    ).toEqual({ [id(1)]: id(2) });
  });

  it("passes over nothing when each path has one build", () => {
    expect(passedOver([testflight(2), build(1)])).toEqual({});
    expect(passedOver([])).toEqual({});
  });
});
