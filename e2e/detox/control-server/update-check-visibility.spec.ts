import { describe, expect, it } from "vitest";

import {
  shouldProbeUpdateCheckVisibility,
  validateArtifactInfoVisibility,
} from "./update-check-visibility.ts";

describe("ArtifactInfo visibility validation", () => {
  it("accepts a complete manifest v1 payload", () => {
    expect(
      validateArtifactInfoVisibility(
        {
          artifactProtocolVersion: 1,
          assets: {},
          manifestFileHash: "manifest-hash",
          manifestUrl: "/storage/manifest",
        },
        "manifest-hash",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects an artifact whose manifest hash differs from the Bundle", () => {
    expect(
      validateArtifactInfoVisibility(
        {
          artifactProtocolVersion: 1,
          assets: {},
          manifestFileHash: "other-hash",
          manifestUrl: "/storage/manifest",
        },
        "manifest-hash",
      ),
    ).toEqual({
      actualManifestFileHash: "other-hash",
      ok: false,
      reason: "manifest-file-hash-mismatch",
    });
  });

  it.each([
    null,
    [],
    { artifactProtocolVersion: 1 },
    { artifactProtocolVersion: 1, assets: [] },
    { artifactProtocolVersion: 1, assets: {}, manifestFileHash: 1 },
    { artifactProtocolVersion: 2, assets: {}, manifestFileHash: "hash", manifestUrl: "/storage/manifest" },
  ])("rejects an invalid v1 ArtifactInfo payload: %j", (payload) => {
    expect(validateArtifactInfoVisibility(payload, "manifest-hash")).toEqual({
      ok: false,
      reason: "invalid-artifact-info",
    });
  });
});

describe("update-check visibility probing", () => {
  it("keeps local provider probes where the control server can observe quickly", () => {
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://127.0.0.1:3007/hot-updater",
        disabled: false,
        rollout: undefined,
        targetCohorts: undefined,
      }),
    ).toBe(true);
  });

  it("skips remote provider probes and lets the app exercise the real update check", () => {
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "https://d30mjvh5w5yleu.cloudfront.net",
        disabled: false,
        rollout: undefined,
        targetCohorts: undefined,
      }),
    ).toBe(false);
  });

  it("skips probes for rollout, cohort, and disabled bundles", () => {
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://localhost:3007/hot-updater",
        disabled: true,
        rollout: undefined,
        targetCohorts: undefined,
      }),
    ).toBe(false);
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://localhost:3007/hot-updater",
        disabled: false,
        rollout: 50,
        targetCohorts: undefined,
      }),
    ).toBe(false);
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://localhost:3007/hot-updater",
        disabled: false,
        rollout: undefined,
        targetCohorts: ["beta"],
      }),
    ).toBe(false);
  });
});
