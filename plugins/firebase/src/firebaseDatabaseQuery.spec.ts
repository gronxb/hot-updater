import type { BundleRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { queryFirebaseDatabaseRows } from "./firebaseDatabaseQuery";

const createBundle = (
  suffix: string,
  platform: "android" | "ios" = "ios",
): BundleRow => ({
  id: `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`,
  platform,
  file_hash: `hash-${suffix}`,
  git_commit_hash: null,
  storage_uri: `storage://bundles/${suffix}.zip`,
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

describe("queryFirebaseDatabaseRows", () => {
  it("applies every order clause before pagination", () => {
    const rows = [
      createBundle("611", "android"),
      createBundle("612", "ios"),
      createBundle("613", "ios"),
    ];
    const input = {
      model: "bundles",
      orderBy: [
        { field: "platform", direction: "asc" },
        { field: "id", direction: "desc" },
      ],
      offset: 0,
      limit: 2,
    } as const;

    const result = queryFirebaseDatabaseRows(rows, input);

    expect(result.map(({ id }) => id)).toEqual([rows[0]?.id, rows[2]?.id]);
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
