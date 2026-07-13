import type { DatabaseAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestState } from "./databaseAdapterTestRunner";
import {
  createBundleRowFixture,
  createChannelRowFixture,
} from "./databaseTestFixtures";

type QueryTestState<TContext> = DatabaseAdapterTestState<
  DatabaseAdapter<TContext>,
  TContext
>;

const seedQueryRows = async <TContext>(state: QueryTestState<TContext>) => {
  const rows = [
    {
      ...createBundleRowFixture("501"),
      message: "Alpha Release",
      target_app_version: null,
      fingerprint_hash: "fingerprint-501",
    },
    { ...createBundleRowFixture("502"), message: "beta release" },
    {
      ...createBundleRowFixture("503"),
      message: "Gamma Preview",
      target_app_version: "2.0.0",
    },
  ];
  await state
    .getAdapter()
    .create(
      { model: "channels", data: createChannelRowFixture("production") },
      state.context,
    );
  for (const row of rows) {
    await state
      .getAdapter()
      .create({ model: "bundles", data: row }, state.context);
  }
  return rows;
};

export const registerDatabaseAdapterQueryTests = <TContext>(
  state: QueryTestState<TContext>,
): void => {
  describe("query semantics", () => {
    it("supports ordered comparison operators", async () => {
      const rows = await seedQueryRows(state);

      const result = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            { field: "id", operator: "gte", value: rows[1].id },
            { field: "id", operator: "lt", value: rows[2].id },
          ],
        },
        state.context,
      );

      expect(result.map(({ id }) => id)).toEqual([rows[1].id]);
    });

    it("supports in and not_in including empty sets", async () => {
      const rows = await seedQueryRows(state);

      const included = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            { field: "id", operator: "in", value: [rows[0].id, rows[2].id] },
          ],
          sortBy: { field: "id", direction: "asc" },
        },
        state.context,
      );
      const emptyExclusion = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [{ field: "id", operator: "not_in", value: [] }],
        },
        state.context,
      );

      expect(included.map(({ id }) => id)).toEqual([rows[0].id, rows[2].id]);
      expect(emptyExclusion).toHaveLength(3);
    });

    it("supports insensitive string pattern operators", async () => {
      const rows = await seedQueryRows(state);

      const contains = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "message",
              operator: "contains",
              value: "RELEASE",
              mode: "insensitive",
            },
          ],
        },
        state.context,
      );
      const startsWith = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "message",
              operator: "starts_with",
              value: "Gamma",
            },
          ],
        },
        state.context,
      );
      const endsWith = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "message",
              operator: "ends_with",
              value: "Preview",
            },
          ],
        },
        state.context,
      );

      expect(contains.map(({ id }) => id)).toEqual([rows[0].id, rows[1].id]);
      expect(startsWith.map(({ id }) => id)).toEqual([rows[2].id]);
      expect(endsWith.map(({ id }) => id)).toEqual([rows[2].id]);
    });

    it("supports insensitive equality operators", async () => {
      const rows = await seedQueryRows(state);

      const equal = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "message",
              value: "ALPHA RELEASE",
              mode: "insensitive",
            },
          ],
        },
        state.context,
      );
      const notEqual = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "message",
              operator: "ne",
              value: "ALPHA RELEASE",
              mode: "insensitive",
            },
          ],
          sortBy: { field: "id", direction: "asc" },
        },
        state.context,
      );

      expect(equal.map(({ id }) => id)).toEqual([rows[0].id]);
      expect(notEqual.map(({ id }) => id)).toEqual([rows[1].id, rows[2].id]);
    });

    it("composes connectors left to right and defaults to AND", async () => {
      const rows = await seedQueryRows(state);

      const result = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            { field: "id", value: rows[0].id },
            {
              field: "id",
              value: rows[1].id,
              connector: "OR",
            },
            { field: "enabled", value: true, connector: "AND" },
          ],
          sortBy: { field: "id", direction: "asc" },
        },
        state.context,
      );

      expect(result.map(({ id }) => id)).toEqual([rows[0].id, rows[1].id]);
    });

    it("compares nullable fields with eq and ne", async () => {
      const rows = await seedQueryRows(state);

      const nullRows = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [{ field: "target_app_version", value: null }],
        },
        state.context,
      );
      const nonNullRows = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [{ field: "target_app_version", operator: "ne", value: null }],
        },
        state.context,
      );
      const otherVersionRows = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "target_app_version",
              operator: "ne",
              value: "1.0.0",
            },
          ],
        },
        state.context,
      );
      const versionsOutsideSet = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "target_app_version",
              operator: "not_in",
              value: ["1.0.0"],
            },
          ],
        },
        state.context,
      );
      const earlierVersions = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            {
              field: "target_app_version",
              operator: "lt",
              value: "2.0.0",
            },
          ],
        },
        state.context,
      );

      expect(nullRows.map(({ id }) => id)).toEqual([rows[0].id]);
      expect(nonNullRows).toHaveLength(2);
      expect(otherVersionRows.map(({ id }) => id)).toEqual([rows[2].id]);
      expect(versionsOutsideSet.map(({ id }) => id)).toEqual([rows[2].id]);
      expect(earlierVersions.map(({ id }) => id)).toEqual([rows[1].id]);
    });

    it("rejects invalid paging, selection, and mutation predicates", async () => {
      await seedQueryRows(state);

      await expect(
        state
          .getAdapter()
          .findMany({ model: "bundles", limit: -1 }, state.context),
      ).rejects.toThrow();
      await expect(
        state
          .getAdapter()
          .findMany({ model: "bundles", offset: -1 }, state.context),
      ).rejects.toThrow();
      await expect(
        state
          .getAdapter()
          .findMany({ model: "bundles", select: [] }, state.context),
      ).rejects.toThrow();
      await expect(
        state
          .getAdapter()
          .update(
            { model: "bundles", where: [], update: { enabled: false } },
            state.context,
          ),
      ).rejects.toThrow();
      await expect(
        state
          .getAdapter()
          .delete({ model: "bundles", where: [] }, state.context),
      ).rejects.toThrow();
    });
  });
};
