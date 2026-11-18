import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSOLE_GIT_URL_GUIDE_URL } from "@/lib/constants";

import { BundleMetadata } from "./BundleMetadata";

const mockUseConfigQuery = vi.fn();

vi.mock("@/lib/api", () => ({
  useConfigQuery: () => mockUseConfigQuery(),
}));

const release = {
  bundle_id: "bundle-1",
  channel_id: "channel-1",
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: null,
  id: "release-1",
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rollout_cohort_count: 1_000,
  scope_key: "scope-1",
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  target_cohorts: [],
  updated_at_ms: 1,
} as ReleaseRow;

const bundle = {
  assetBaseStorageUri: "storage://assets",
  gitCommitHash: "abc123def4567890",
  id: "bundle-1",
  manifestFileHash: "manifest-hash",
  manifestStorageUri: "storage://manifest",
  patches: [],
  platform: "ios",
} as Bundle;

describe("BundleMetadata", () => {
  beforeEach(() => {
    mockUseConfigQuery.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("links git commits when console.gitUrl is configured", () => {
    mockUseConfigQuery.mockReturnValue({
      data: { console: { gitUrl: "https://github.com/acme/app" } },
      isFetched: true,
    });

    render(<BundleMetadata bundle={bundle} release={release} />);

    const link = screen.getByRole("link", { name: "Open git commit" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/app/commit/abc123def4567890",
    );
    expect(screen.queryByRole("button", { name: "Not linked" })).toBeNull();
  });

  it("shows a Not linked tooltip when console.gitUrl is missing", () => {
    mockUseConfigQuery.mockReturnValue({
      data: { console: {} },
      isFetched: true,
    });

    render(<BundleMetadata bundle={bundle} release={release} />);

    expect(screen.queryByRole("link", { name: "Open git commit" })).toBeNull();

    const trigger = screen.getByRole("button", { name: "Not linked" });
    fireEvent.click(trigger);

    expect(screen.getByText(/console\.gitUrl/)).toBeDefined();
    const guide = screen.getByRole("link", { name: "Learn more" });
    expect(guide.getAttribute("href")).toBe(CONSOLE_GIT_URL_GUIDE_URL);
  });

  it("waits for config before showing the Not linked tooltip", () => {
    mockUseConfigQuery.mockReturnValue({
      data: undefined,
      isFetched: false,
    });

    render(<BundleMetadata bundle={bundle} release={release} />);

    expect(screen.queryByRole("button", { name: "Not linked" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open git commit" })).toBeNull();
  });
});
