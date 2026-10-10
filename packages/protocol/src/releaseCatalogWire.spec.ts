import { describe, expect, it } from "vitest";

import type { ReleaseCatalog } from "./releaseCatalog";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "./releaseCatalogScope";
import {
  type ExpectedReleaseCatalogScope,
  getUtf8ByteLength,
  hasExpectedReleaseCatalogScope,
  MAX_RELEASE_CATALOG_WIRE_BYTES,
  parseReleaseCatalog,
} from "./releaseCatalogWire";

const channelKey = encodeChannelKey("preview/한글");
const scope: ExpectedReleaseCatalogScope = {
  channelKey,
  platform: "ios",
  strategy: "FINGERPRINT",
  fingerprintHash: "fingerprint-123",
};
const descriptor = {
  releaseId: "01906c0c-5f14-7000-8000-000000000001",
  kind: "BUNDLE" as const,
  bundleId: "01906c0c-5f14-7000-8000-000000000002",
  rolloutCohortCount: 1000,
  targetCohorts: ["preview"],
  shouldForceUpdate: false,
  message: null,
};
const catalog: ReleaseCatalog = {
  schemaVersion: 1,
  catalogId: "test-project",
  catalogHash: `sha256:${"ab".repeat(32)}`,
  scopeKey: createReleaseCatalogScopeKey({
    channelKey,
    platform: "ios",
    strategy: "FINGERPRINT",
    fingerprintHash: "fingerprint-123",
  }),
  generation: 3,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  releases: [descriptor],
  rollbackReleases: [
    {
      ...descriptor,
      releaseId: "01906c0c-5f14-7000-8000-000000000003",
      bundleId: "01906c0c-5f14-7000-8000-000000000004",
      rolloutCohortCount: 0,
    },
  ],
};

const parse = (value: unknown) =>
  parseReleaseCatalog(JSON.stringify(value), scope);

describe("parseReleaseCatalog", () => {
  it("accepts a catalog of the expected scope", () => {
    expect(parse(catalog)).toEqual(catalog);
  });

  it.each<[string, Partial<ReleaseCatalog>]>([
    ["another schema version", { schemaVersion: 2 as never }],
    ["an empty catalog ID", { catalogId: "" }],
    ["a malformed hash", { catalogHash: "sha256:catalog" }],
    ["a zero generation", { generation: 0 }],
    ["an unsafe generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
    ["another fallback policy", { fallbackPolicy: "NONE" as never }],
    ["no rollback releases", { rollbackReleases: undefined as never }],
    [
      "an invalid release ID",
      { releases: [{ ...descriptor, releaseId: "test-release" }] },
    ],
    [
      "a bundle without an artifact ID",
      { releases: [{ ...descriptor, bundleId: null }] },
    ],
    [
      "a release kind other than BUNDLE",
      { releases: [{ ...descriptor, kind: "BUILTIN" as never }] },
    ],
    [
      "a cohort rollout above the client range",
      { releases: [{ ...descriptor, rolloutCohortCount: 1001 }] },
    ],
    [
      "too many target cohorts on one release",
      {
        releases: [
          { ...descriptor, targetCohorts: Array(101).fill("preview") },
        ],
      },
    ],
    [
      "too many distinct target cohorts across current and rollback releases",
      {
        releases: Array.from({ length: 5 }, (_, index) => ({
          ...descriptor,
          targetCohorts: Array.from(
            { length: 100 },
            (_, cohort) => `cohort-${index * 100 + cohort}`,
          ),
        })),
        rollbackReleases: [
          {
            ...descriptor,
            targetCohorts: Array.from(
              { length: 13 },
              (_, cohort) => `rollback-${cohort}`,
            ),
          },
        ],
      },
    ],
    [
      "another fingerprint's scope",
      {
        scopeKey: createReleaseCatalogScopeKey({
          channelKey,
          platform: "ios",
          strategy: "FINGERPRINT",
          fingerprintHash: "fingerprint-456",
        }),
      },
    ],
    [
      "another channel's scope",
      {
        scopeKey: createReleaseCatalogScopeKey({
          channelKey: encodeChannelKey("production"),
          platform: "ios",
          strategy: "FINGERPRINT",
          fingerprintHash: "fingerprint-123",
        }),
      },
    ],
  ])("rejects %s", (_name, invalid) => {
    expect(parse({ ...catalog, ...invalid })).toBeNull();
  });

  it("rejects a body that is not JSON or exceeds the wire limit", () => {
    expect(parseReleaseCatalog("{", scope)).toBeNull();
    const padded = JSON.stringify({
      ...catalog,
      catalogId: "x".repeat(MAX_RELEASE_CATALOG_WIRE_BYTES),
    });
    expect(parseReleaseCatalog(padded, scope)).toBeNull();
  });
});

describe("hasExpectedReleaseCatalogScope", () => {
  it("compares the scope key's parts, and rejects a key that does not parse", () => {
    expect(hasExpectedReleaseCatalogScope(catalog, scope)).toBe(true);
    expect(
      hasExpectedReleaseCatalogScope(catalog, {
        channelKey,
        platform: "android",
        strategy: "FINGERPRINT",
        fingerprintHash: "fingerprint-123",
      }),
    ).toBe(false);
    expect(
      hasExpectedReleaseCatalogScope({ scopeKey: "not-a-scope" }, scope),
    ).toBe(false);
  });
});

describe("getUtf8ByteLength", () => {
  it("counts UTF-8 bytes, a surrogate pair as four", () => {
    expect(getUtf8ByteLength("a")).toBe(1);
    expect(getUtf8ByteLength("é")).toBe(2);
    expect(getUtf8ByteLength("한")).toBe(3);
    expect(getUtf8ByteLength("😀")).toBe(4);
    expect(getUtf8ByteLength("a한😀")).toBe(
      new TextEncoder().encode("a한😀").length,
    );
  });
});
