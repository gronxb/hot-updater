import type { DatabaseAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestState } from "./databaseAdapterTestRunner";
import {
  createBundleRowFixture,
  createChannelRowFixture,
} from "./databaseTestFixtures";

type BundleTestState<TContext> = DatabaseAdapterTestState<
  DatabaseAdapter<TContext>,
  TContext
>;

const seedChannel = async <TContext>(
  state: BundleTestState<TContext>,
  id = "production",
): Promise<void> => {
  await state
    .getAdapter()
    .create(
      { model: "channels", data: createChannelRowFixture(id) },
      state.context,
    );
};

export const registerDatabaseAdapterBundleTests = <TContext>(
  state: BundleTestState<TContext>,
): void => {
  describe("bundles", () => {
    it("creates a row and returns only selected fields", async () => {
      await seedChannel(state);
      const bundle = createBundleRowFixture("1");

      const created = await state
        .getAdapter()
        .create(
          { model: "bundles", data: bundle, select: ["id", "channel_id"] },
          state.context,
        );

      expect(created).toEqual({
        id: bundle.id,
        channel_id: bundle.channel_id,
      });
      await expect(
        state.getAdapter().findOne(
          {
            model: "bundles",
            where: [{ field: "id", value: bundle.id }],
          },
          state.context,
        ),
      ).resolves.toEqual(bundle);
    });

    it("returns null when no bundle matches", async () => {
      await expect(
        state.getAdapter().findOne(
          {
            model: "bundles",
            where: [
              {
                field: "id",
                value: "ffffffff-ffff-ffff-ffff-ffffffffffff",
              },
            ],
          },
          state.context,
        ),
      ).resolves.toBeNull();
    });

    it("updates explicit false, null, and empty-array values", async () => {
      await seedChannel(state);
      const bundle = createBundleRowFixture("2");
      await state
        .getAdapter()
        .create({ model: "bundles", data: bundle }, state.context);

      const updated = await state.getAdapter().update(
        {
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
          update: { enabled: false, message: null, target_cohorts: [] },
        },
        state.context,
      );

      expect(updated).toMatchObject({
        id: bundle.id,
        enabled: false,
        message: null,
        target_cohorts: [],
      });
      expect(updated?.file_hash).toBe(bundle.file_hash);
    });

    it("filters, orders, offsets, and limits before returning rows", async () => {
      await seedChannel(state);
      await seedChannel(state, "staging");
      const first = { ...createBundleRowFixture("11"), enabled: false };
      const second = createBundleRowFixture("12", "channel-staging", "staging");
      const third = createBundleRowFixture("13");
      for (const bundle of [first, second, third]) {
        await state
          .getAdapter()
          .create({ model: "bundles", data: bundle }, state.context);
      }

      const rows = await state.getAdapter().findMany(
        {
          model: "bundles",
          where: [
            { field: "enabled", value: true },
            {
              field: "channel_id",
              value: "channel-staging",
              operator: "ne",
              connector: "AND",
            },
          ],
          sortBy: { field: "id", direction: "desc" },
          offset: 0,
          limit: 1,
        },
        state.context,
      );

      expect(rows).toEqual([third]);
    });

    it("uses the same predicates for count", async () => {
      await seedChannel(state);
      const enabled = createBundleRowFixture("21");
      const disabled = { ...createBundleRowFixture("22"), enabled: false };
      for (const bundle of [enabled, disabled]) {
        await state
          .getAdapter()
          .create({ model: "bundles", data: bundle }, state.context);
      }

      await expect(
        state.getAdapter().count(
          {
            model: "bundles",
            where: [{ field: "enabled", value: false }],
          },
          state.context,
        ),
      ).resolves.toBe(1);
    });

    it("treats an empty in predicate as matching no rows", async () => {
      await seedChannel(state);
      await state
        .getAdapter()
        .create(
          { model: "bundles", data: createBundleRowFixture("31") },
          state.context,
        );

      await expect(
        state.getAdapter().findMany(
          {
            model: "bundles",
            where: [{ field: "id", value: [], operator: "in" }],
          },
          state.context,
        ),
      ).resolves.toEqual([]);
    });

    it("deletes every matching bundle row", async () => {
      await seedChannel(state);
      for (const suffix of ["41", "42"]) {
        await state
          .getAdapter()
          .create(
            { model: "bundles", data: createBundleRowFixture(suffix) },
            state.context,
          );
      }

      await state.getAdapter().delete(
        {
          model: "bundles",
          where: [{ field: "channel_id", value: "channel-production" }],
        },
        state.context,
      );

      await expect(
        state.getAdapter().findMany({ model: "bundles" }, state.context),
      ).resolves.toEqual([]);
    });

    it("rejects duplicate ids and bundles with missing channels", async () => {
      const bundle = createBundleRowFixture("51");
      await expect(
        state
          .getAdapter()
          .create({ model: "bundles", data: bundle }, state.context),
      ).rejects.toThrow();

      await seedChannel(state);
      await state
        .getAdapter()
        .create({ model: "bundles", data: bundle }, state.context);

      await expect(
        state
          .getAdapter()
          .create({ model: "bundles", data: bundle }, state.context),
      ).rejects.toThrow();
    });
  });
};
