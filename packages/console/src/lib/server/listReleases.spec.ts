import type { ReleaseModel, ReleaseRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { listReleases } from "./listReleases";

const release = (index: number): ReleaseRow =>
  ({
    id: String(index).padStart(3, "0"),
  }) as ReleaseRow;

const rows = Array.from({ length: 41 }, (_, index) => release(index + 1));

const createReleaseModel = () => {
  const findMany = vi.fn<ReleaseModel["findMany"]>(async (input) => {
    const filtered = rows
      .filter(
        (row) =>
          (input.afterReleaseId === undefined ||
            row.id > input.afterReleaseId) &&
          (input.beforeReleaseId === undefined ||
            row.id < input.beforeReleaseId),
      )
      .sort((left, right) =>
        input.afterReleaseId === undefined
          ? right.id.localeCompare(left.id)
          : left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
    return input.afterReleaseId === undefined ? filtered : filtered.reverse();
  });
  const model: ReleaseModel = {
    findById: vi.fn(),
    findMany,
    findManyByScope: vi.fn(),
  };
  return { findMany, model };
};

describe("listReleases", () => {
  it("moves forward and backward without duplicates or ordering changes", async () => {
    const { model } = createReleaseModel();
    const first = await listReleases(model, { limit: 20 });
    const second = await listReleases(model, {
      beforeReleaseId: first.data.at(-1)?.id,
      limit: 20,
      page: 2,
    });
    const third = await listReleases(model, {
      beforeReleaseId: second.data.at(-1)?.id,
      limit: 20,
      page: 3,
    });
    const backToSecond = await listReleases(model, {
      afterReleaseId: third.data[0]?.id,
      limit: 20,
      page: 2,
    });
    const backToFirst = await listReleases(model, {
      afterReleaseId: backToSecond.data[0]?.id,
      limit: 20,
      page: 1,
    });

    expect(first.data.map(({ id }) => id)).toEqual(
      rows
        .slice(21)
        .reverse()
        .map(({ id }) => id),
    );
    expect(second.data.map(({ id }) => id)).toEqual(
      rows
        .slice(1, 21)
        .reverse()
        .map(({ id }) => id),
    );
    expect(third.data.map(({ id }) => id)).toEqual(["001"]);
    expect(backToSecond.data).toEqual(second.data);
    expect(backToFirst.data).toEqual(first.data);
    expect(third.pagination.hasNextPage).toBe(false);
    expect(backToSecond.pagination).toEqual({
      currentPage: 2,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it("passes exact Release filters to the repository", async () => {
    const { findMany, model } = createReleaseModel();
    await listReleases(model, {
      bundleId: "bundle-1",
      channelId: "channel-1",
      enabled: false,
      limit: 20,
      platform: "ios",
      targetAppVersion: "1.2.x",
    });

    expect(findMany).toHaveBeenCalledWith({
      bundleId: "bundle-1",
      channelId: "channel-1",
      enabled: false,
      limit: 21,
      platform: "ios",
      targetAppVersion: "1.2.x",
    });
  });
});
