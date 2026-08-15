import type { BundleRow } from "@hot-updater/plugin-core";
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
  channel_id: `channel-${channel}`,
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

describe("queryFirebaseDatabaseRows", () => {
  it("applies every order clause before pagination", () => {
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

    const result = queryFirebaseDatabaseRows(rows, input);

    expect(result.map(({ id }) => id)).toEqual([rows[2]?.id, rows[0]?.id]);
  });

  it("returns a bounded descending id page", () => {
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

    const result = queryFirebaseDatabaseRows(rows, input);

    expect(result.map(({ id }) => id)).toEqual([rows[2]?.id, rows[1]?.id]);
  });
});
