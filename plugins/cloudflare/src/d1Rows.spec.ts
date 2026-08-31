import { expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundlePatchRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
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

it("preserves explicit null Release ids on an Insights row", () => {
  expect(
    parseD1Row("bundle_events", createBundleEventRowFixture("1", 1)),
  ).toMatchObject({ from_release_id: null, to_release_id: null });
});

it.each(["from_release_id", "to_release_id"])(
  "rejects an omitted Insights field: %s",
  (field) => {
    const row: Record<string, unknown> = {
      ...createBundleEventRowFixture("1", 1),
    };
    delete row[field];

    expect(() => parseD1Row("bundle_events", row)).toThrow(
      "D1 returned an invalid bundle_events row",
    );
  },
);

it.each([
  { from_bundle_id: null },
  { to_bundle_id: null },
  { type: "UNCHANGED", from_bundle_id: "bundle-old", update_strategy: null },
])("rejects an invalid Insights direction shape", (overrides) => {
  expect(() =>
    parseD1Row("bundle_events", {
      ...createBundleEventRowFixture("1", 1),
      ...overrides,
    }),
  ).toThrow("D1 returned an invalid bundle_events row");
});
