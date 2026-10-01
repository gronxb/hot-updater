import type {
  CompiledCatalogSegment,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  parseReleaseCatalogScopeKey,
} from "@hot-updater/protocol";
import { normalizeRange, rangesIntersect } from "verkit";

import { parseCompiledCatalog } from "../db/releaseCatalog";

/** A new bundle's auto-patch target: where it is released, and to whom. */
export interface BaseCandidateTarget {
  readonly channel: string;
  readonly platform: "ios" | "android";
  readonly fingerprintHash: string | null;
  readonly appVersion: string | null;
}

/** What a base-candidate key names: a catalog scope, and an app-version scope's target range. */
export interface BaseCandidateQuery {
  readonly scopeKey: string;
  readonly range: string | null;
}

/**
 * A new bundle's base-candidate key: the Release Catalog scope its devices
 * update from, and for an app version its normalized range; null for a
 * target without a valid range.
 */
export const targetBaseCandidateKey = (
  target: BaseCandidateTarget,
): string | null => {
  const channelKey = encodeChannelKey(target.channel);
  if (target.fingerprintHash) {
    return JSON.stringify([
      createReleaseCatalogScopeKey({
        channelKey,
        fingerprintHash: target.fingerprintHash,
        platform: target.platform,
        strategy: "FINGERPRINT",
      }),
    ]);
  }
  const range =
    target.appVersion === null ? null : normalizeRange(target.appVersion);
  return range === null
    ? null
    : JSON.stringify([
        createReleaseCatalogScopeKey({
          channelKey,
          platform: target.platform,
          strategy: "APP_VERSION",
        }),
        range,
      ]);
};

/** The scope and range a base-candidate key names; null for any other string. */
export const parseBaseCandidateKey = (
  key: string,
): BaseCandidateQuery | null => {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
    const [scopeKey, text] = parsed as [string, unknown];
    const { strategy } = parseReleaseCatalogScopeKey(scopeKey);
    if (strategy === "FINGERPRINT") {
      return parsed.length === 1 ? { scopeKey, range: null } : null;
    }
    const range =
      parsed.length === 2 && typeof text === "string"
        ? normalizeRange(text)
        : null;
    return range === null ? null : { scopeKey, range };
  } catch {
    return null;
  }
};

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
