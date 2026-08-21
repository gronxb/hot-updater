import { describe, expect, it } from "vitest";

import {
  shouldProbeUpdateCheckVisibility,
  validateArtifactInfoVisibility,
} from "./update-check-visibility.ts";

describe("ArtifactInfo visibility validation", () => {
  it("accepts id-free v1 payloads with exact string and null hashes", () => {
    expect(
      validateArtifactInfoVisibility(
        {
          changedAssets: {},
          fileHash: "archive-hash",
          fileUrl: "/storage/archive",
          manifestFileHash: "manifest-hash",
          manifestUrl: "/storage/manifest",
        },
        "archive-hash",
      ),
    ).toEqual({ ok: true });
    expect(
      validateArtifactInfoVisibility({ fileHash: null, fileUrl: null }, null),
    ).toEqual({ ok: true });
  });

  it("rejects an artifact whose file hash differs from the deployed Bundle", () => {
    expect(
      validateArtifactInfoVisibility(
        { fileHash: null, fileUrl: "/storage/archive" },
        "archive-hash",
      ),
    ).toEqual({
      actualFileHash: null,
      ok: false,
      reason: "file-hash-mismatch",
    });
  });

  it.each([
    null,
    [],
    { fileHash: "archive-hash" },
    { fileHash: 1, fileUrl: "/storage/archive" },
    { fileHash: "archive-hash", fileUrl: false },
    { changedAssets: [], fileHash: "archive-hash", fileUrl: null },
  ])("rejects an invalid v1 ArtifactInfo payload: %j", (payload) => {
    expect(validateArtifactInfoVisibility(payload, "archive-hash")).toEqual({
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
