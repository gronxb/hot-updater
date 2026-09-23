import type {
  HotUpdaterCoreApi,
  KeysetInput,
  ReleaseFilter,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { listReleases, readReleaseFilter } from "./listReleases";

const release = (index: number): ReleaseRow =>
  ({ id: String(index).padStart(3, "0") }) as ReleaseRow;

const rows = Array.from({ length: 41 }, (_, index) => release(index + 1));

/** Core's keyset reads over 41 releases: rows past the cursor in order, at most limit. */
const createCore = () => {
  const reads: number[] = [];
  const listReleases = vi.fn(
    async (
      input: KeysetInput & { readonly filter: ReleaseFilter },
    ): Promise<ReleaseRow[]> => {
      const asc = input.order === "asc";
      const page = [...rows]
        .sort((left, right) =>
          asc
            ? left.id.localeCompare(right.id)
            : right.id.localeCompare(left.id),
        )
        .filter(
          (row) =>
            input.after === undefined ||
            (asc ? row.id > input.after : row.id < input.after),
        )
        .slice(0, input.limit);
      reads.push(page.length);
      return page;
    },
  );
  return {
    core: { listReleases } satisfies Pick<HotUpdaterCoreApi, "listReleases">,
    reads,
  };
};

const all: ReleaseFilter = { kind: "all" };

describe("listReleases", () => {
  it("moves forward and backward by key without duplicates or reordering", async () => {
    const { core, reads } = createCore();
    const first = await listReleases(core, { filter: all, limit: 20 });
    const second = await listReleases(core, {
      filter: all,
      beforeReleaseId: first.next,
      limit: 20,
    });
    const third = await listReleases(core, {
      filter: all,
      beforeReleaseId: second.next,
      limit: 20,
    });
    const backToSecond = await listReleases(core, {
      filter: all,
      afterReleaseId: third.previous,
      limit: 20,
    });
    const backToFirst = await listReleases(core, {
      filter: all,
      afterReleaseId: backToSecond.previous,
      limit: 20,
    });

    expect(first.data.map(({ id }) => id)).toEqual(
      rows
        .slice(21)
        .reverse()
        .map(({ id }) => id),
    );
    expect(first.previous).toBeUndefined();
    expect(second.data.map(({ id }) => id)).toEqual(
      rows
        .slice(1, 21)
        .reverse()
        .map(({ id }) => id),
    );
    expect(third.data.map(({ id }) => id)).toEqual(["001"]);
    expect(third.next).toBeUndefined();
    expect(backToSecond.data).toEqual(second.data);
    expect(backToFirst.data).toEqual(first.data);
    // Each page reads only its own rows.
    expect(reads).toEqual([20, 20, 1, 20, 20]);
  });

  it("names the next page only after a full page", async () => {
    const { core } = createCore();

    await expect(
      listReleases(core, { filter: all, limit: 41 }),
    ).resolves.toMatchObject({ next: "001" });
    const last = await listReleases(core, {
      filter: all,
      beforeReleaseId: "001",
      limit: 41,
    });
    expect(last).toEqual({ data: [] });
  });

  it("marks the newest page when a previous page comes back short", async () => {
    const { core } = createCore();

    const newest = await listReleases(core, {
      filter: all,
      afterReleaseId: "035",
      limit: 20,
    });

    expect(newest.data.map(({ id }) => id)).toEqual([
      "041",
      "040",
      "039",
      "038",
      "037",
      "036",
    ]);
    expect(newest.previous).toBeUndefined();
    expect(newest.next).toBe("036");
  });

  it("passes the filter set to core unchanged", async () => {
    const { core } = createCore();
    const filter: ReleaseFilter = {
      kind: "channelPlatform",
      channelId: "channel-1",
      platform: "android",
      enabled: true,
    };

    await listReleases(core, { filter, limit: 5 });

    expect(core.listReleases).toHaveBeenCalledWith({
      filter,
      order: "desc",
      limit: 5,
    });
  });
});

describe("readReleaseFilter", () => {
  it("accepts the filter sets the release indexes serve", () => {
    expect(readReleaseFilter(undefined)).toEqual({ kind: "all" });
    expect(
      readReleaseFilter({
        kind: "channelPlatform",
        channelId: "c",
        platform: "ios",
        enabled: false,
      }),
    ).toEqual({
      kind: "channelPlatform",
      channelId: "c",
      platform: "ios",
      enabled: false,
    });
    expect(readReleaseFilter({ kind: "bundle", bundleId: "b" })).toEqual({
      kind: "bundle",
      bundleId: "b",
    });
    expect(readReleaseFilter({ kind: "scope", scopeKey: "s" })).toEqual({
      kind: "scope",
      scopeKey: "s",
    });
  });

  it.each([
    [{ kind: "channelPlatform", channelId: "c" }, "platform"],
    [{ kind: "channelPlatform", platform: "ios" }, "channelId"],
    [{ kind: "scope", scopeKey: "s", enabled: "yes" }, "enabled"],
    [{ kind: "platform", platform: "ios" }, "Invalid release filter."],
    [
      { kind: "targetAppVersion", targetAppVersion: "1.0" },
      "Invalid release filter.",
    ],
  ])("refuses %j", (filter, message) => {
    expect(() => readReleaseFilter(filter)).toThrow(message);
  });
});
