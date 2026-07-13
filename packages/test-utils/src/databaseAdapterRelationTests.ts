import type { DatabaseAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestState } from "./databaseAdapterTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
} from "./databaseTestFixtures";

type RelationTestState<TContext> = DatabaseAdapterTestState<
  DatabaseAdapter<TContext>,
  TContext
>;

const seedBundlePair = async <TContext>(
  state: RelationTestState<TContext>,
): Promise<readonly [string, string]> => {
  const channel = createChannelRowFixture("production");
  const base = createBundleRowFixture("61", channel.id);
  const target = createBundleRowFixture("62", channel.id);
  await state
    .getAdapter()
    .create({ model: "channels", data: channel }, state.context);
  await state
    .getAdapter()
    .create({ model: "bundles", data: base }, state.context);
  await state
    .getAdapter()
    .create({ model: "bundles", data: target }, state.context);
  return [base.id, target.id];
};

export const registerDatabaseAdapterRelationTests = <TContext>(
  state: RelationTestState<TContext>,
): void => {
  describe("channels", () => {
    it("creates and retrieves explicit channel rows", async () => {
      const production = createChannelRowFixture("production");
      const staging = createChannelRowFixture("staging");
      await state
        .getAdapter()
        .create({ model: "channels", data: production }, state.context);
      await state
        .getAdapter()
        .create({ model: "channels", data: staging }, state.context);

      await expect(
        state.getAdapter().findOne(
          {
            model: "channels",
            where: [{ field: "name", value: "production" }],
          },
          state.context,
        ),
      ).resolves.toEqual(production);
      await expect(
        state.getAdapter().findMany(
          {
            model: "channels",
            sortBy: { field: "name", direction: "asc" },
          },
          state.context,
        ),
      ).resolves.toEqual([production, staging]);
    });

    it("rejects duplicate channel ids and names", async () => {
      const channel = createChannelRowFixture("production");
      await state
        .getAdapter()
        .create({ model: "channels", data: channel }, state.context);

      await expect(
        state
          .getAdapter()
          .create({ model: "channels", data: channel }, state.context),
      ).rejects.toThrow();

      await expect(
        state.getAdapter().create(
          {
            model: "channels",
            data: createChannelRowFixture("production", "another-id"),
          },
          state.context,
        ),
      ).rejects.toThrow();
    });
  });

  describe("bundle_patches", () => {
    it("creates, orders, selects, and deletes patch rows", async () => {
      const [baseId, targetId] = await seedBundlePair(state);
      const second = createBundlePatchRowFixture("72", targetId, baseId, 2);
      const first = createBundlePatchRowFixture("71", targetId, baseId, 1);
      for (const patch of [second, first]) {
        await state
          .getAdapter()
          .create({ model: "bundle_patches", data: patch }, state.context);
      }

      const rows = await state.getAdapter().findMany(
        {
          model: "bundle_patches",
          where: [{ field: "bundle_id", value: targetId }],
          select: ["id", "order_index"],
          sortBy: { field: "order_index", direction: "asc" },
        },
        state.context,
      );
      expect(rows).toEqual([
        { id: first.id, order_index: 1 },
        { id: second.id, order_index: 2 },
      ]);

      await state.getAdapter().delete(
        {
          model: "bundle_patches",
          where: [{ field: "bundle_id", value: targetId }],
        },
        state.context,
      );
      await expect(
        state.getAdapter().findMany({ model: "bundle_patches" }, state.context),
      ).resolves.toEqual([]);
    });

    it("rejects missing owner and base bundle references", async () => {
      const [baseId, targetId] = await seedBundlePair(state);
      const missingOwner = createBundlePatchRowFixture(
        "81",
        "ffffffff-ffff-ffff-ffff-fffffffffff1",
        baseId,
      );
      const missingBase = createBundlePatchRowFixture(
        "82",
        targetId,
        "ffffffff-ffff-ffff-ffff-fffffffffff2",
      );

      await expect(
        state
          .getAdapter()
          .create(
            { model: "bundle_patches", data: missingOwner },
            state.context,
          ),
      ).rejects.toThrow();
      await expect(
        state
          .getAdapter()
          .create(
            { model: "bundle_patches", data: missingBase },
            state.context,
          ),
      ).rejects.toThrow();
    });
  });
};
