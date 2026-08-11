import { describe, expect, it } from "vitest";

import type { BundleEventPersistenceRow } from "../persistence";
import { searchEventInstallations } from "./installationSearch";

type UpdateAppliedRow = BundleEventPersistenceRow & {
  readonly type: "UPDATE_APPLIED";
};

function eventRow(overrides: Partial<UpdateAppliedRow> = {}): UpdateAppliedRow {
  return {
    id: "event-1",
    type: "UPDATE_APPLIED",
    install_id: "install-1",
    user_id: "user-1",
    username: "alice",
    from_bundle_id: "bundle-old",
    to_bundle_id: "bundle-new",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "default",
    update_strategy: "fingerprint",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 1,
    ...overrides,
  };
}

describe("searchEventInstallations", () => {
  it.each([
    ["installation id", "INSTALL-1"],
    ["user id", "USER-1"],
    ["username", "ALICE"],
  ])("matches %s without case sensitivity", (_identity, query) => {
    const row = eventRow();

    const result = searchEventInstallations({
      rows: [row],
      query,
      limit: 10,
      offset: 0,
    });

    expect(result.data.map(({ installId }) => installId)).toEqual([
      "install-1",
    ]);
  });

  it("returns the newest state when an older identity matches", () => {
    const rows = [
      eventRow({
        id: "event-old",
        username: "legacy-name",
        to_bundle_id: "bundle-old",
        received_at_ms: 1,
      }),
      eventRow({
        id: "event-new",
        username: "current-name",
        to_bundle_id: "bundle-current",
        received_at_ms: 2,
      }),
    ];

    const result = searchEventInstallations({
      rows,
      query: "LEGACY-NAME",
      limit: 10,
      offset: 0,
    });

    expect(result.data).toEqual([
      {
        installId: "install-1",
        username: "current-name",
        userId: "user-1",
        lastKnownBundleId: "bundle-current",
        latestStatus: "UPDATE_APPLIED",
        platform: "ios",
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        receivedAtMs: 2,
      },
    ]);
  });

  it("sorts installation ids by code point", () => {
    const rows = [
      eventRow({ install_id: "install-z" }),
      eventRow({ install_id: "install-a" }),
      eventRow({ install_id: "install-A" }),
    ];

    const result = searchEventInstallations({
      rows,
      query: "",
      limit: 10,
      offset: 0,
    });

    expect(result.data.map(({ installId }) => installId)).toEqual([
      "install-A",
      "install-a",
      "install-z",
    ]);
  });

  it("applies the offset and caps the page size at 100", () => {
    const rows = Array.from({ length: 105 }, (_, index) =>
      eventRow({ install_id: `install-${index.toString().padStart(3, "0")}` }),
    );

    const result = searchEventInstallations({
      rows,
      query: "",
      limit: 200,
      offset: 2,
    });

    expect(result.data).toHaveLength(100);
    expect(result.data.at(0)?.installId).toBe("install-002");
    expect(result.data.at(-1)?.installId).toBe("install-101");
    expect(result.pagination).toEqual({ total: 105, limit: 200, offset: 2 });
  });
});
