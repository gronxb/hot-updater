import type {
  CompiledCatalogSegment,
  CompiledReleaseCatalog,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import type { ReleaseCatalogDescriptor } from "@hot-updater/protocol";
import { rangesIntersect } from "verkit";

import { parseCompiledCatalog } from "../db/releaseCatalog";

/** A compiled segment as a range: its version when it holds exactly one. */
const segmentRange = ({
  lower,
  upper,
}: Pick<CompiledCatalogSegment, "lower" | "upper">): string =>
  lower?.inclusive && upper?.inclusive && lower.version === upper.version
    ? lower.version
    : [
        lower === null ? "" : `${lower.inclusive ? ">=" : ">"}${lower.version}`,
        upper === null ? "" : `${upper.inclusive ? "<=" : "<"}${upper.version}`,
      ]
        .join(" ")
        .trim() || "*";

/**
 * Auto-patch bases from compiled segments and the descriptors their indexes
 * name: the rollback releases of each segment whose range intersects
 * `range`, or every descriptor of a list with no segment (a fingerprint
 * scope's), newest release first, each bundle once and older than
 * `bundleId`, at most `limit`. A compact catalog is one list of segments; a
 * partitioned one is its rows, each with its own descriptors.
 */
export const baseBundleIdsFrom = (
  lists: readonly {
    readonly segments:
      | readonly Pick<
          CompiledCatalogSegment,
          "lower" | "upper" | "rollbackReleaseIndexes"
        >[]
      | null;
    readonly descriptors: readonly ReleaseCatalogDescriptor[];
  }[],
  range: string | null,
  bundleId: string,
  limit: number,
): string[] => {
  const serving = new Map<string, ReleaseCatalogDescriptor>();
  for (const { segments, descriptors } of lists) {
    const indexes =
      segments === null
        ? descriptors.map((_, index) => index)
        : segments.flatMap((segment) =>
            range !== null && rangesIntersect(range, segmentRange(segment))
              ? segment.rollbackReleaseIndexes
              : [],
          );
    for (const index of indexes) {
      const descriptor = descriptors[index]!;
      serving.set(descriptor.releaseId, descriptor);
    }
  }
  const newestFirst = [...serving.values()].sort((left, right) =>
    left.releaseId < right.releaseId ? 1 : -1,
  );
  const ids: string[] = [];
  for (const { bundleId: id } of newestFirst) {
    if (ids.length >= limit) break;
    if (id !== null && id < bundleId && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

/** Auto-patch bases from a compiled catalog, as `baseBundleIdsOf` reads it. */
export const baseBundleIdsOfCompiled = (
  catalog: CompiledReleaseCatalog,
  range: string | null,
  bundleId: string,
  limit: number,
): string[] =>
  baseBundleIdsFrom(
    [
      catalog.strategy === "FINGERPRINT"
        ? {
            descriptors: catalog.rollbackReleaseIndexes.map(
              (index) => catalog.releaseDescriptors[index]!,
            ),
            segments: null,
          }
        : {
            descriptors: catalog.releaseDescriptors,
            segments: catalog.segments,
          },
    ],
    range,
    bundleId,
    limit,
  );

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
): string[] =>
  baseBundleIdsOfCompiled(
    parseCompiledCatalog(row.payload, row.strategy),
    range,
    bundleId,
    limit,
  );
