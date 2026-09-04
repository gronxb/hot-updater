import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
  parseFirebaseInsightsInstallationRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";

describe("parseFirebaseBundleRow", () => {
  it("rejects a missing metadata field", () => {
    const { metadata: _metadata, ...row } =
      createBundleRowFixture("missing-metadata");

    expect(() =>
      parseFirebaseBundleRow(row, "bundles/missing-metadata"),
    ).toThrow("Invalid Firebase database data");
  });

  it("rejects explicit null metadata", () => {
    expect(() =>
      parseFirebaseBundleRow(
        {
          ...createBundleRowFixture("null-metadata"),
          metadata: null,
        },
        "bundles/null-metadata",
      ),
    ).toThrow("Invalid Firebase database data");
  });

  it("preserves safe archive sizes above 2 GiB", () => {
    expect(
      parseFirebaseBundleRow(createBundleRowFixture("large"), "bundles/large"),
    ).toMatchObject({ archive_byte_size: 3_000_000_001 });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid archive size %s",
    (archiveByteSize) => {
      expect(() =>
        parseFirebaseBundleRow(
          {
            ...createBundleRowFixture("invalid-size"),
            archive_byte_size: archiveByteSize,
          },
          "bundles/invalid-size",
        ),
      ).toThrow("Invalid Firebase database data");
    },
  );
});

describe("parseFirebasePatchRow", () => {
  const row = createBundlePatchRowFixture("large", "bundle", "base");

  it("preserves safe patch sizes above 2 GiB", () => {
    expect(parseFirebasePatchRow(row, "bundle_patches/large")).toMatchObject({
      byte_size: 3_000_000_002,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid patch size %s",
    (patchByteSize) => {
      expect(() =>
        parseFirebasePatchRow(
          { ...row, byte_size: patchByteSize },
          "bundle_patches/invalid-size",
        ),
      ).toThrow("Invalid Firebase database data");
    },
  );
});

describe("parseFirebaseBundleEventRow", () => {
  it("preserves explicit null Release ids", () => {
    expect(
      parseFirebaseBundleEventRow(
        createBundleEventRowFixture("1", 1),
        "bundle_events/event-1",
      ),
    ).toMatchObject({ from_release_id: null, to_release_id: null });
  });

  it.each(["from_release_id", "to_release_id"])(
    "rejects an omitted field: %s",
    (field) => {
      const row: Record<string, unknown> = {
        ...createBundleEventRowFixture("1", 1),
      };
      delete row[field];

      expect(() =>
        parseFirebaseBundleEventRow(row, "bundle_events/event-1"),
      ).toThrow("Invalid Firebase database data");
    },
  );

  it.each([
    { from_bundle_id: null },
    { to_bundle_id: null },
    { type: "UNCHANGED", from_bundle_id: "bundle-old", update_strategy: null },
  ])("rejects an invalid direction shape", (overrides) => {
    expect(() =>
      parseFirebaseBundleEventRow(
        { ...createBundleEventRowFixture("1", 1), ...overrides },
        "bundle_events/event-1",
      ),
    ).toThrow("Invalid Firebase database data");
  });
});

describe("parseFirebaseInsightsInstallationRow", () => {
  const event = createBundleEventRowFixture("installation", 100);
  const installation = {
    id: event.id,
    type: event.type,
    install_id: event.install_id,
    user_id: event.user_id,
    username: event.username,
    to_bundle_id: event.to_bundle_id,
    platform: event.platform,
    app_version: event.app_version,
    channel: event.channel,
    cohort: event.cohort,
    received_at_ms: event.received_at_ms,
  };

  it("parses the latest installation projection", () => {
    expect(
      parseFirebaseInsightsInstallationRow(
        installation,
        `bundle_installations/${event.install_id}`,
      ),
    ).toEqual(installation);
  });

  it("rejects an unknown latest event type", () => {
    expect(() =>
      parseFirebaseInsightsInstallationRow(
        { ...installation, type: "UNKNOWN" },
        `bundle_installations/${event.install_id}`,
      ),
    ).toThrow("Invalid Firebase database data");
  });
});
