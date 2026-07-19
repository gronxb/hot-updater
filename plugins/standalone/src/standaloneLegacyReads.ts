import type {
  DatabaseAdapterImplementation,
  DatabaseWhere,
} from "@hot-updater/plugin-core";
import { bundleToRow } from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import {
  matchesStandaloneWhere,
  queryStandaloneRows,
} from "./standaloneDatabaseQuery";
import { loadRows } from "./standaloneLegacyData";

type LegacyReads = Pick<
  DatabaseAdapterImplementation,
  "count" | "findOne" | "findMany"
>;

export const createLegacyReads = (
  remote: StandaloneBundleRemote,
): LegacyReads => ({
  async count(input) {
    const where = input.where as
      | readonly DatabaseWhere<"bundles">[]
      | undefined;
    const remoteWindow = await remote.loadBundleWindow({
      where,
      limit: 1,
      offset: 0,
    });
    if (remoteWindow) return remoteWindow.total;
    return queryStandaloneRows(await loadRows(remote, "bundles"), {
      where,
    }).length;
  },
  async findOne(input) {
    if (input.model === "bundles") {
      const idSelector = input.where?.length === 1 ? input.where[0] : undefined;
      if (
        idSelector?.field === "id" &&
        (idSelector.operator === undefined || idSelector.operator === "eq") &&
        typeof idSelector.value === "string"
      ) {
        const bundle = await remote.loadBundle(idSelector.value);
        const row = bundle ? bundleToRow(bundle) : null;
        return row && matchesStandaloneWhere(row, input.where) ? row : null;
      }
      return (
        queryStandaloneRows(await loadRows(remote, "bundles"), {
          where: input.where,
          limit: 1,
        })[0] ?? null
      );
    }
    if (input.model === "bundle_events") return null;
    return (
      queryStandaloneRows(await loadRows(remote, "bundle_patches"), {
        where: input.where as
          | readonly DatabaseWhere<"bundle_patches">[]
          | undefined,
        limit: 1,
      })[0] ?? null
    );
  },
  async findMany(input) {
    switch (input.model) {
      case "bundles": {
        const where = input.where as
          | readonly DatabaseWhere<"bundles">[]
          | undefined;
        const remoteWindow = await remote.loadBundleWindow({
          where,
          limit: input.limit,
          offset: input.offset,
          sortBy: input.sortBy,
        });
        if (remoteWindow) return remoteWindow.rows;
        return queryStandaloneRows(await loadRows(remote, "bundles"), {
          where,
          limit: input.limit,
          offset: input.offset,
          sortBy: input.sortBy,
        });
      }
      case "bundle_patches":
        return queryStandaloneRows(await loadRows(remote, "bundle_patches"), {
          where: input.where as
            | readonly DatabaseWhere<"bundle_patches">[]
            | undefined,
          limit: input.limit,
          offset: input.offset,
          sortBy: input.sortBy,
        });
      case "bundle_events":
        return [];
    }
  },
});
