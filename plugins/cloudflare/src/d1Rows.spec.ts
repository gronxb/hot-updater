import { expect, it } from "vitest";

import { createBundlePatchRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { parseD1Row } from "./d1Rows";

const bundleD1Row = {
  id: "bundle-1",
  platform: "android",
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  archive_byte_size: 3_000_000_001,
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

it("defaults a legacy bundle's missing archive byte size", () => {
  const row: Record<string, unknown> = { ...bundleD1Row };
  delete row["archive_byte_size"];

  expect(parseD1Row("bundles", row)).toMatchObject({
    archive_byte_size: 0,
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

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
  "rejects invalid SQLite archive size %s",
  (archiveByteSize) => {
    expect(() =>
      parseD1Row("bundles", {
        ...bundleD1Row,
        archive_byte_size: archiveByteSize,
      }),
    ).toThrow("D1 returned an invalid bundles row");
  },
);

it("preserves SQLite patch sizes above 2 GiB", () => {
  const patch = createBundlePatchRowFixture("large", "bundle", "base");

  expect(parseD1Row("bundle_patches", patch)).toMatchObject({
    byte_size: 3_000_000_002,
  });
});

it.each(["null", "[]", "1", '"metadata"'])(
  "rejects non-object SQLite metadata %s",
  (metadata) => {
    expect(() => parseD1Row("bundles", { ...bundleD1Row, metadata })).toThrow(
      "D1 returned an invalid bundles row",
    );
  },
);
