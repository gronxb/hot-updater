import type { BundleEventRow, BundleRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { queryFirebaseDatabaseRows } from "./firebaseDatabaseQuery";

const createBundle = (suffix: string, channel = "production"): BundleRow => ({
  id: `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`,
  platform: "ios",
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${suffix}`,
  git_commit_hash: null,
  message: null,
  channel,
  storage_uri: `storage://bundles/${suffix}.zip`,
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const createEvent = (
  id: string,
  installId: string,
  receivedAtMs: number,
): BundleEventRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: null,
  username: null,
  from_bundle_id: "00000000-0000-0000-0000-000000000698",
  to_bundle_id: "00000000-0000-0000-0000-000000000699",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  update_strategy: "fingerprint",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

describe("queryFirebaseDatabaseRows", () => {
  it("applies every order clause before pagination", () => {
    // Given
    const rows = [
      createBundle("611", "preview"),
      createBundle("612", "production"),
      createBundle("613", "preview"),
    ];
    const input = {
      model: "bundles",
      orderBy: [
        { field: "channel", direction: "asc" },
        { field: "id", direction: "desc" },
      ],
      offset: 0,
      limit: 2,
    } as const;

    // When
    const result = queryFirebaseDatabaseRows(rows, input);

    // Then
    expect(result.map(({ id }) => id)).toEqual([rows[2]?.id, rows[0]?.id]);
  });

  it("keeps the first ordered row for every distinct key", () => {
    // Given
    const rows = [
      createEvent("00000000-0000-0000-0000-000000000601", "install-a", 100),
      createEvent("00000000-0000-0000-0000-000000000602", "install-a", 200),
      createEvent("00000000-0000-0000-0000-000000000603", "install-a", 150),
      createEvent("00000000-0000-0000-0000-000000000604", "install-b", 50),
    ];
    const input = {
      model: "bundle_events",
      distinctOn: { fields: ["install_id"] },
      orderBy: [
        { field: "install_id", direction: "asc" },
        { field: "received_at_ms", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
      offset: 0,
      limit: 100,
    } as const;

    // When
    const result = queryFirebaseDatabaseRows(rows, input);

    // Then
    expect(result.map(({ id }) => id)).toEqual([rows[1]?.id, rows[3]?.id]);
  });

  it("returns a bounded descending id page", () => {
    // Given
    const rows = [
      createBundle("201"),
      createBundle("202"),
      createBundle("203"),
    ];
    const input = {
      model: "bundles",
      orderBy: [{ field: "id", direction: "desc" }],
      offset: 0,
      limit: 2,
    } as const;

    // When
    const result = queryFirebaseDatabaseRows(rows, input);

    // Then
    expect(result.map(({ id }) => id)).toEqual([rows[2]?.id, rows[1]?.id]);
  });
});
