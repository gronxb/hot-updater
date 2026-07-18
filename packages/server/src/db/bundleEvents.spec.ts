import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createBundleEventService } from "./bundleEvents";
import {
  createEvent,
  expectSingleMaterialization,
} from "./bundleEvents.testFixtures";
import { BUNDLE_EVENT_SCAN_PAGE_SIZE } from "./bundleEventScan";

describe("bundle event installation search", () => {
  it("pages an empty query over stable latest-per-install rows", async () => {
    const database = createInMemoryDatabaseAdapter();
    const rows = [
      createEvent("install-a", 1, { to_bundle_id: "old-a" }),
      createEvent("install-a", 4, { to_bundle_id: "latest-a" }),
      createEvent("install-b", 3, { to_bundle_id: "latest-b" }),
      createEvent("install-c", 2, { to_bundle_id: "latest-c" }),
    ];
    await Promise.all(
      rows.map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);

    const firstPage = await service.searchInstallations("", 2, 0);
    const secondPage = await service.searchInstallations("", 2, 2);

    expect(firstPage.pagination).toEqual({ total: 3, limit: 2, offset: 0 });
    expect(secondPage.pagination).toEqual({ total: 3, limit: 2, offset: 2 });
    expect(firstPage.data.map(({ installId }) => installId)).toEqual([
      "install-a",
      "install-b",
    ]);
    expect(secondPage.data.map(({ installId }) => installId)).toEqual([
      "install-c",
    ]);
    expect(firstPage.data[0]?.lastKnownBundleId).toBe("latest-a");
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [input] of findMany.mock.calls) {
      expect(input).toMatchObject({
        model: "bundle_events",
        limit: BUNDLE_EVENT_SCAN_PAGE_SIZE,
        offset: 0,
        orderBy: [
          { field: "received_at_ms", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
      });
    }
  });

  it("returns the latest row when a historical identity matches", async () => {
    const database = createInMemoryDatabaseAdapter();
    await database.create({
      model: "bundle_events",
      data: {
        ...createEvent("install-a", 1, { to_bundle_id: "old-bundle" }),
        username: "historical-name",
      },
    });
    await database.create({
      model: "bundle_events",
      data: {
        ...createEvent("install-a", 2, { to_bundle_id: "latest-bundle" }),
        username: "current-name",
      },
    });
    const service = createBundleEventService(database);
    const result = await service.searchInstallations("historical", 20, 0);

    expect(result.data).toMatchObject([
      {
        installId: "install-a",
        username: "current-name",
        lastKnownBundleId: "latest-bundle",
      },
    ]);
  });

  it("finds a late historical-identity page from one materialization", async () => {
    const database = createInMemoryDatabaseAdapter();
    const installIds = Array.from(
      { length: 205 },
      (_, index) => `install-${index.toString().padStart(3, "0")}`,
    );
    const rows = installIds.flatMap((installId, index) => [
      {
        ...createEvent(installId, index + 1, {
          to_bundle_id: `old-${installId}`,
        }),
        username: `historical-match-${installId}`,
      },
      createEvent(installId, 1_000 + index, {
        to_bundle_id: `latest-${installId}`,
      }),
    ]);
    await Promise.all(
      rows.map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const findMany = vi.spyOn(database, "findMany");
    const count = vi.spyOn(database, "count");
    const service = createBundleEventService(database);
    const context = { requestId: "search-request" };

    const result = await service.searchInstallations(
      "historical-match",
      5,
      200,
      context,
    );

    expect(result.pagination).toEqual({ total: 205, limit: 5, offset: 200 });
    expect(result.data.map(({ installId }) => installId)).toEqual(
      installIds.slice(200),
    );
    expect(
      result.data.map(({ lastKnownBundleId }) => lastKnownBundleId),
    ).toEqual(installIds.slice(200).map((id) => `latest-${id}`));
    expectSingleMaterialization(findMany);
    expect(findMany.mock.calls[0]?.[0].where).toEqual([
      {
        field: "type",
        operator: "in",
        value: ["UPDATE_APPLIED", "RECOVERED"],
      },
      {
        field: "received_at_ms",
        operator: "lt",
        value: expect.any(Number),
      },
    ]);
    expect(count).not.toHaveBeenCalledWith(
      expect.objectContaining({ distinct: expect.anything() }),
      context,
    );
  });

  it("aggregates repeated installation rows without adjacency", async () => {
    const database = createInMemoryDatabaseAdapter();
    const crossingGroup = Array.from({ length: 205 }, (_, index) =>
      createEvent("install-a", index + 1, { to_bundle_id: `old-${index}` }),
    );
    await Promise.all(
      [
        ...crossingGroup,
        createEvent("install-b", 300, { to_bundle_id: "deleted-bundle" }),
        createEvent("install-c", 299, { to_bundle_id: "bundle-a" }),
      ].map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const count = vi.spyOn(database, "count");
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);
    const context = { requestId: "overview-request" };

    const overview = await service.getBundleEventOverview(context);

    expect(overview).toEqual({
      trackedInstallations: 3,
      bundles: [
        { bundleId: "bundle-a", installations: 1 },
        { bundleId: "deleted-bundle", installations: 1 },
        { bundleId: "old-204", installations: 1 },
      ],
    });
    expect(count).not.toHaveBeenCalled();
    expectSingleMaterialization(findMany);
    expect(findMany.mock.calls[0]?.[1]).toBe(context);
  });
});
