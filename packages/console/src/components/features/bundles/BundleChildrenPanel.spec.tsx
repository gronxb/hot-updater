import type { Bundle } from "@hot-updater/plugin-core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BundleChildrenPanel } from "./BundleChildrenPanel";

type LifecycleBundle = Bundle & {
  readonly lifecycle?: {
    readonly active: number;
    readonly recovered: number;
    readonly lastSeenAt?: string | null;
  };
};

const baseBundle: LifecycleBundle = {
  id: "0195a408-8f13-7d9b-8df4-basebundle1",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "base-hash",
  storageUri: "s3://bucket/base.zip",
  gitCommitHash: "deadbeef",
  message: "Base bundle",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
  lifecycle: {
    active: 4,
    recovered: 1,
    lastSeenAt: "2026-06-26T06:00:00.000Z",
  },
};

const childBundle: LifecycleBundle = {
  ...baseBundle,
  id: "0195a408-8f13-7d9b-8df4-childbundl1",
  fileHash: "child-hash",
  message: "Patch bundle",
  patches: [
    {
      baseBundleId: baseBundle.id,
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/patch.zip",
    },
  ],
  lifecycle: {
    active: 9,
    recovered: 0,
    lastSeenAt: "2026-06-26T06:05:00.000Z",
  },
};

describe("BundleChildrenPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders provider supplied lifecycle counts for related bundles", () => {
    render(
      <BundleChildrenPanel
        panelId="bundle-lineage-panel"
        bundle={baseBundle}
        bundles={[childBundle]}
        loading={false}
        onDetailClick={() => undefined}
      />,
    );

    expect(screen.getAllByText("Lifecycle").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("4 ACTIVE")).toBeTruthy();
    expect(screen.getByText("1 RECOVERED")).toBeTruthy();
    expect(screen.getByText("9 ACTIVE")).toBeTruthy();
    expect(screen.getByText("0 RECOVERED")).toBeTruthy();
  });

  it("keeps a neutral relationship surface when lifecycle data is absent", () => {
    const bundleWithoutLifecycle: Bundle = {
      ...baseBundle,
      lifecycle: undefined,
    } as Bundle;

    render(
      <BundleChildrenPanel
        panelId="bundle-lineage-panel"
        bundle={bundleWithoutLifecycle}
        bundles={[]}
        loading={false}
        onDetailClick={() => undefined}
      />,
    );

    expect(screen.getByText("No direct patch bundles.")).toBeTruthy();
    expect(screen.queryByText("0 ACTIVE")).toBeNull();
    expect(screen.queryByText("0 RECOVERED")).toBeNull();
  });
});
