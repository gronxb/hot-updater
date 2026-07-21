import type { DatabasePluginImplementation } from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  rowToBundle,
} from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import {
  matchesStandaloneWhere,
  queryStandaloneRows,
} from "./standaloneDatabaseQuery";
import { StandaloneDatabaseError } from "./standaloneHttp";
import { loadRows } from "./standaloneLegacyData";

type LegacyWrites = Pick<
  DatabasePluginImplementation,
  "create" | "update" | "delete"
>;

export const createLegacyWrites = (
  remote: StandaloneBundleRemote,
): LegacyWrites => ({
  async create(input) {
    switch (input.model) {
      case "bundles":
        await remote.createBundle(rowToBundle(input.data));
        return input.data;
      case "bundle_patches": {
        const owner = await remote.loadBundle(input.data.bundle_id);
        if (!owner) {
          throw new StandaloneDatabaseError(
            "request-failed",
            `Bundle ${input.data.bundle_id} was not found.`,
            404,
          );
        }
        if (
          input.data.base_bundle_id !== owner.id &&
          !(await remote.loadBundle(input.data.base_bundle_id))
        ) {
          throw new StandaloneDatabaseError(
            "request-failed",
            `Bundle ${input.data.base_bundle_id} was not found.`,
            404,
          );
        }
        const patches = bundleToPatchRows(owner);
        if (patches.some(({ id }) => id === input.data.id)) {
          throw new StandaloneDatabaseError(
            "request-failed",
            `Bundle patch ${input.data.id} already exists.`,
            409,
          );
        }
        await remote.updateBundle(
          rowToBundle(bundleToRow(owner), [...patches, input.data]),
        );
        return input.data;
      }
      case "bundle_events":
        throw new StandaloneDatabaseError(
          "request-failed",
          "bundle_events are not supported by the standalone repository.",
          501,
        );
    }
  },
  async update(input) {
    const bundleId = String(input.where[0]?.value ?? "");
    const current = await remote.loadBundle(bundleId);
    if (!current) return null;
    const nextRow = {
      ...bundleToRow(current),
      ...input.update,
    };
    await remote.updateBundle(rowToBundle(nextRow, bundleToPatchRows(current)));
    return nextRow;
  },
  async delete(input) {
    if (input.model === "bundles") {
      const rows = queryStandaloneRows(await loadRows(remote, "bundles"), {
        where: input.where,
      });
      for (const row of rows) await remote.deleteBundle(row.id);
      return;
    }
    const bundles = await remote.loadBundles();
    for (const bundle of bundles) {
      const patches = bundleToPatchRows(bundle);
      const remaining = patches.filter(
        (row) => !matchesStandaloneWhere(row, input.where),
      );
      if (remaining.length !== patches.length) {
        await remote.updateBundle(rowToBundle(bundleToRow(bundle), remaining));
      }
    }
  },
});
