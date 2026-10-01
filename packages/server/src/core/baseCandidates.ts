import type {
  CompiledCatalogSegment,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import { rangesIntersect } from "verkit";

import { parseCompiledCatalog } from "../db/releaseCatalog";

/** A compiled segment as a range: its version when it holds exactly one. */
const segmentRange = ({ lower, upper }: CompiledCatalogSegment): string =>
  lower?.inclusive && upper?.inclusive && lower.version === upper.version
    ? lower.version
    : [
        lower === null ? "" : `${lower.inclusive ? ">=" : ">"}${lower.version}`,
        upper === null ? "" : `${upper.inclusive ? "<=" : "<"}${upper.version}`,
      ]
        .join(" ")
        .trim() || "*";

/**
 * Auto-patch bases from a scope's compiled Release Catalog, which holds
 * every enabled bundle release of the scope: those whose range intersects
 * `range` (all of them in a fingerprint scope), newest release first, each
 * bundle once and older than `bundleId`, at most `limit`.
 */
export const baseBundleIdsOf = (
  row: ReleaseCatalogRow,
  range: string | null,
  bundleId: string,
  limit: number,
): string[] => {
  const catalog = parseCompiledCatalog(row.payload, row.strategy);
  const serving = new Set(
    catalog.strategy === "FINGERPRINT"
      ? catalog.rollbackReleaseIndexes
      : catalog.segments.flatMap((segment) =>
          range !== null && rangesIntersect(range, segmentRange(segment))
            ? segment.rollbackReleaseIndexes
            : [],
        ),
  );
  const newestFirst = catalog.releaseDescriptors
    .map((descriptor, index) => ({ descriptor, index }))
    .sort((left, right) =>
      left.descriptor.releaseId < right.descriptor.releaseId ? 1 : -1,
    );
  const ids: string[] = [];
  for (const { descriptor, index } of newestFirst) {
    if (ids.length >= limit) break;
    const id = descriptor.bundleId;
    if (
      serving.has(index) &&
      descriptor.kind === "BUNDLE" &&
      id !== null &&
      id < bundleId &&
      !ids.includes(id)
    ) {
      ids.push(id);
    }
  }
  return ids;
};
