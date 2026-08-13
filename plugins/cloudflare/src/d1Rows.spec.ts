import { expect, it } from "vitest";

import { parseD1Row } from "./d1Rows";

const bundleD1Row = {
  id: "bundle-1",
  platform: "android",
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  metadata: '{"build":1}',
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
} as const;

it("parses SQLite JSON into an artifact-only Bundle row", () => {
  const row = parseD1Row("bundles", bundleD1Row);

  expect(row).toMatchObject({
    metadata: { build: 1 },
  });
});

it("rejects an invalid artifact platform", () => {
  expect(() =>
    parseD1Row("bundles", { ...bundleD1Row, platform: "web" }),
  ).toThrow("D1 returned an invalid bundles row");
});

it("rejects corrupt SQLite metadata JSON", () => {
  expect(() =>
    parseD1Row("bundles", { ...bundleD1Row, metadata: "{" }),
  ).toThrow("D1 returned an invalid bundles row");
});

it.each(["null", "[]", "1", '"metadata"'])(
  "rejects non-object SQLite metadata %s",
  (metadata) => {
    expect(() => parseD1Row("bundles", { ...bundleD1Row, metadata })).toThrow(
      "D1 returned an invalid bundles row",
    );
  },
);
