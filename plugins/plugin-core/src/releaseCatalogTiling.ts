import {
  canonicalizeAppVersion,
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  RELEASE_CATALOG_FALLBACK_POLICY,
  RELEASE_CATALOG_SCHEMA_VERSION,
  type Release,
  type ReleaseCatalogDescriptor,
} from "@hot-updater/protocol";
import { tryParse } from "verkit";

import {
  atomicVersionSegments,
  canonicalStringify,
  type CatalogVersionBound,
  collectFrontierReleaseIds,
  compileAppVersion,
  type CompiledCatalogSegment,
  type CompiledReleaseCatalog,
  intervalContainsSegment,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  rangeToIntervals,
  ReleaseCatalogCompilationError,
  releaseDescriptor,
  sha256,
  validateReleases,
  versionInSegment,
  type VersionInterval,
} from "./releaseCatalogCompiler.ts";

// A partitioned APP_VERSION catalog stores the compiler's merged segments as
// rows, one segment per row, with an explicit empty row for every interval no
// segment covers, so the rows tile the whole version line. A row's lower key
// orders as the compiler orders lower bounds, so a device's row is the one
// with the greatest lower key at or below its version's key.

type AppVersionCatalog = Extract<
  CompiledReleaseCatalog,
  { readonly strategy: "APP_VERSION" }
>;

/**
 * The longest lower key a partition row may have: the width of the
 * `lower_key` column. A scope with a longer endpoint stays a compact row.
 * Exported for core's partition table and its key-fit check.
 */
export const RELEASE_CATALOG_LOWER_KEY_MAX_BYTES = 256;

/**
 * One stored row of a partitioned release catalog: the compiler's canonical
 * JSON of one merged segment (or of one gap) with the descriptors that apply
 * to it, indexed locally. Exported because core writes and reads these rows.
 */
export interface ReleaseCatalogPartition {
  /** Orders as the segment's lower bound; see `releaseCatalogLookupKey`. */
  readonly lowerKey: string;
  /** The canonical compiled catalog of this one segment. */
  readonly payload: string;
  /** `sha256:` of `payload`, which a catalog head's chain hash names. */
  readonly partitionHash: string;
  /** UTF-8 bytes of `payload`. */
  readonly byteSize: number;
}

/**
 * Why a tiling call refused its rows, so core can tell a torn read
 * (`INCOMPLETE_COVER`, `INVALID_TILING`) from a corrupt row
 * (`INVALID_PARTITION`) or a caller's mistake.
 */
export type ReleaseCatalogTilingErrorCode =
  | "DUPLICATE_RELEASE"
  | "FINGERPRINT_NOT_PARTITIONED"
  | "INCOMPLETE_COVER"
  | "INVALID_PARTITION"
  | "INVALID_TILING";

/**
 * Stored rows that can't be a tiling, or an insert given rows that don't
 * cover the release's range. Exported so core can tell a torn read or a
 * corrupt row from a release the compiler refuses.
 */
export class ReleaseCatalogTilingError extends Error {
  readonly name = "ReleaseCatalogTilingError";

  constructor(
    readonly code: ReleaseCatalogTilingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// --- Lower keys ---------------------------------------------------------
//
// ASCII, ordered bytewise exactly as verkit `compare` orders versions, and
// at one version an inclusive lower bound before an exclusive one:
// - `-` is the open lower end, below every version key ("A" and above);
// - a number is its digit count as one letter (A = 1 … P = 16) and then its
//   digits, so a longer number sorts later;
// - major, minor and patch, then `_` for a release or `-` for a prerelease,
//   which sorts first;
// - a prerelease lists its identifiers, `#` and a number for a numeric one
//   or `$`, the text and `!` for another, and ends with `!`, so a numeric
//   identifier sorts before text and a shorter list before a longer one;
// - `=` for an inclusive bound, `>` for an exclusive one.
// A version this can't encode, or one whose key is longer than the column,
// leaves the scope compact: the functions below return null.

const OPEN_LOWER_KEY = "-";

const encodeNumber = (digits: string): string | null => {
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  if (trimmed.length > 16) return null;
  return `${String.fromCharCode(0x40 + trimmed.length)}${trimmed}`;
};

const encodeVersion = (version: string): string | null => {
  const parsed = tryParse(version);
  if (parsed === null) return null;
  const main = [parsed.major, parsed.minor, parsed.patch].map((part) =>
    encodeNumber(String(part)),
  );
  if (main.some((part) => part === null)) return null;
  const core = main.join("");
  if (!parsed.prerelease?.length) return `${core}_`;
  let key = `${core}-`;
  for (const identifier of parsed.prerelease) {
    const text = String(identifier);
    if (/^\d+$/.test(text)) {
      // verkit compares digit identifiers as Numbers, which are exact only
      // up to the largest safe integer.
      if (!Number.isSafeInteger(Number(text))) return null;
      const encoded = encodeNumber(text);
      if (encoded === null) return null;
      key += `#${encoded}`;
    } else if (/^[0-9A-Za-z-]+$/.test(text)) {
      key += `$${text}!`;
    } else {
      return null;
    }
  }
  return `${key}!`;
};

const lowerKeyOf = (bound: CatalogVersionBound | null): string | null => {
  if (bound === null) return OPEN_LOWER_KEY;
  const version = encodeVersion(bound.version);
  if (version === null) return null;
  const key = `${version}${bound.inclusive ? "=" : ">"}`;
  return key.length <= RELEASE_CATALOG_LOWER_KEY_MAX_BYTES ? key : null;
};

/** The lower bound of whatever follows an interval that ends at `upper`. */
const after = (upper: CatalogVersionBound): CatalogVersionBound => ({
  inclusive: !upper.inclusive,
  version: upper.version,
});

/**
 * The key a device's app version looks its partition up by: the row with
 * the greatest lower key at or below it. Null when the version has no
 * canonical form. Exported for core's update check.
 */
export function releaseCatalogLookupKey(appVersion: string): string | null {
  const canonical = canonicalizeAppVersion(appVersion);
  return canonical === null
    ? null
    : lowerKeyOf({ inclusive: true, version: canonical });
}

/**
 * The rows of a range's interval: the row with the greatest lower key at or
 * below `start`, then every row whose lower key is above `start` and below
 * `stop` (null: no end). Exported because core's insert reads these ranges.
 */
export interface ReleaseCatalogKeyRange {
  readonly start: string;
  readonly stop: string | null;
}

/**
 * The key ranges of the rows a new release with `targetAppVersion` lands in,
 * one per interval of the range, which are the rows `insertReleaseIntoTiling`
 * needs. Null when an endpoint's key doesn't fit, so the scope stays
 * compact. Throws `INVALID_TARGET_RANGE` as the compiler does. Exported for
 * core's insert, which reads only these rows.
 */
export function releaseCatalogKeyRanges(
  targetAppVersion: string,
): readonly ReleaseCatalogKeyRange[] | null {
  const ranges: ReleaseCatalogKeyRange[] = [];
  for (const interval of rangeToIntervals(targetAppVersion)) {
    const start = lowerKeyOf(interval.lower);
    const stop =
      interval.upper === null ? null : lowerKeyOf(after(interval.upper));
    if (start === null || (interval.upper !== null && stop === null)) {
      return null;
    }
    ranges.push({ start, stop });
  }
  return ranges;
}

// --- Partition rows -----------------------------------------------------

const encoder = new TextEncoder();

const describeInterval = ({ lower, upper }: VersionInterval): string =>
  `${lower === null ? "(-∞" : `${lower.inclusive ? "[" : "("}${lower.version}`}, ${
    upper === null ? "∞)" : `${upper.version}${upper.inclusive ? "]" : ")"}`
  }`;

/** Newest first, as the compiler orders releases and descriptors. */
const byNewest = (
  left: ReleaseCatalogDescriptor,
  right: ReleaseCatalogDescriptor,
): number => right.releaseId.localeCompare(left.releaseId);

const segmentPayload = (
  interval: VersionInterval,
  descriptors: readonly ReleaseCatalogDescriptor[],
  releaseIndexes: readonly number[],
): AppVersionCatalog => ({
  fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
  releaseDescriptors: descriptors,
  schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
  segments: [
    {
      lower: interval.lower,
      releaseIndexes,
      rollbackReleaseIndexes: descriptors.map((_, index) => index),
      upper: interval.upper,
    },
  ],
  strategy: "APP_VERSION",
});

/**
 * The stored row of one segment, refused as the compiler refuses a compact
 * catalog: at most 256 KB and 512 distinct target cohorts, now per row.
 */
const toPartition = async (
  lowerKey: string,
  interval: VersionInterval,
  payload: AppVersionCatalog,
): Promise<ReleaseCatalogPartition> => {
  const cohorts = new Set(
    payload.releaseDescriptors.flatMap(({ targetCohorts }) => targetCohorts),
  );
  if (cohorts.size > MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE) {
    throw new ReleaseCatalogCompilationError(
      "DISTINCT_TARGET_COHORT_LIMIT",
      `App versions ${describeInterval(interval)} exceed ${MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE} distinct target cohorts`,
    );
  }
  const canonical = canonicalStringify(payload);
  const byteSize = encoder.encode(canonical).byteLength;
  if (byteSize > MAX_COMPILED_CATALOG_BYTES) {
    throw new ReleaseCatalogCompilationError(
      "CATALOG_OVERSIZE",
      `Release catalog for app versions ${describeInterval(interval)} is ${byteSize} bytes; maximum is ${MAX_COMPILED_CATALOG_BYTES}`,
    );
  }
  return {
    byteSize,
    lowerKey,
    partitionHash: await sha256(canonical),
    payload: canonical,
  };
};

/** Lower keys strictly increase along a tiling; anything else stays compact. */
const keysIncrease = (keys: readonly string[]): boolean =>
  keys.every((key, index) => index === 0 || keys[index - 1]! < key);

/**
 * The gap-filled tiling of a compiled APP_VERSION catalog: every merged
 * segment, with its descriptors re-indexed locally, and an empty row for
 * each interval between them and at either end.
 */
const tile = async (
  catalog: AppVersionCatalog,
): Promise<readonly ReleaseCatalogPartition[] | null> => {
  const rows: {
    readonly interval: VersionInterval;
    readonly segment: CompiledCatalogSegment | null;
  }[] = [];
  const gap = (
    lower: CatalogVersionBound | null,
    upper: CatalogVersionBound | null,
  ) => {
    rows.push({ interval: { lower, upper }, segment: null });
  };
  const { segments } = catalog;
  if (segments.length === 0) {
    gap(null, null);
  } else {
    const first = segments[0]!;
    if (first.lower !== null) gap(null, after(first.lower));
    segments.forEach((segment, index) => {
      rows.push({ interval: segment, segment });
      const next = segments[index + 1];
      if (
        next !== undefined &&
        // Neighbours whose bounds meet leave no gap between them.
        !(
          segment.upper !== null &&
          next.lower !== null &&
          segment.upper.version === next.lower.version &&
          segment.upper.inclusive !== next.lower.inclusive
        )
      ) {
        gap(after(segment.upper!), after(next.lower!));
      }
    });
    const last = segments.at(-1)!;
    if (last.upper !== null) gap(after(last.upper), null);
  }

  const keys = rows.map(({ interval }) => lowerKeyOf(interval.lower));
  if (keys.some((key) => key === null) || !keysIncrease(keys as string[])) {
    return null;
  }
  return Promise.all(
    rows.map(({ interval, segment }, index) => {
      if (segment === null) {
        return toPartition(
          keys[index]!,
          interval,
          segmentPayload(interval, [], []),
        );
      }
      const used = [...segment.rollbackReleaseIndexes].sort(
        (left, right) => left - right,
      );
      const local = new Map(used.map((global, at) => [global, at]));
      return toPartition(
        keys[index]!,
        interval,
        segmentPayload(
          interval,
          used.map((global) => catalog.releaseDescriptors[global]!),
          segment.releaseIndexes.map((global) => local.get(global)!),
        ),
      );
    }),
  );
};

/**
 * The tiling of a scope's releases: the enabled ones, compiled as
 * `compileReleaseCatalog` compiles them, without its whole-catalog size and
 * cohort caps. Each row is held to those caps instead, and refused with the
 * compiler's error naming its app versions. Null when an endpoint's key
 * doesn't fit, so the scope stays compact. Exported for core's conversion,
 * edits and rebuilds.
 */
export async function compileReleaseCatalogTiling(input: {
  readonly releases: readonly Release[];
}): Promise<readonly ReleaseCatalogPartition[] | null> {
  const releases = validateReleases(input.releases, "APP_VERSION");
  const { envelope, retainedReleases } = compileAppVersion(releases);
  return tile({
    ...envelope,
    releaseDescriptors: retainedReleases.map(releaseDescriptor),
  });
}

/**
 * The tiling of a stored compact APP_VERSION catalog, so a scope converts
 * without reading its releases. Assembling the result gives back exactly
 * `catalog`, or it throws `INVALID_TILING`. A FINGERPRINT catalog has one
 * interval and is never partitioned. Exported for core's conversion.
 */
export async function tileCompiledReleaseCatalog(
  catalog: CompiledReleaseCatalog,
): Promise<readonly ReleaseCatalogPartition[] | null> {
  if (catalog.strategy !== "APP_VERSION") {
    throw new ReleaseCatalogTilingError(
      "FINGERPRINT_NOT_PARTITIONED",
      "A FINGERPRINT release catalog is never partitioned",
    );
  }
  const partitions = await tile(catalog);
  if (
    partitions !== null &&
    assembleReleaseCatalog(partitions).canonicalPayload !==
      canonicalStringify(catalog)
  ) {
    throw new ReleaseCatalogTilingError(
      "INVALID_TILING",
      "The compact release catalog isn't the compiler's canonical output",
    );
  }
  return partitions;
}

// --- Reading stored rows ------------------------------------------------

interface ParsedPartition {
  readonly row: ReleaseCatalogPartition;
  readonly catalog: AppVersionCatalog;
  readonly segment: CompiledCatalogSegment;
  /** The lower key of the row after this one; null at the end of the line. */
  readonly endKey: string | null;
}

const isBound = (value: unknown): value is CatalogVersionBound | null =>
  value === null ||
  (typeof value === "object" &&
    typeof (value as CatalogVersionBound).inclusive === "boolean" &&
    typeof (value as CatalogVersionBound).version === "string");

const isIndexList = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.every(
    (index, at) =>
      Number.isSafeInteger(index) &&
      index >= 0 &&
      (at === 0 || (value[at - 1] as number) < index),
  );

const isDescriptor = (value: unknown): value is ReleaseCatalogDescriptor => {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = value as ReleaseCatalogDescriptor;
  return (
    Object.keys(descriptor).length === 7 &&
    typeof descriptor.releaseId === "string" &&
    descriptor.kind === "BUNDLE" &&
    (descriptor.bundleId === null || typeof descriptor.bundleId === "string") &&
    Number.isSafeInteger(descriptor.rolloutCohortCount) &&
    Array.isArray(descriptor.targetCohorts) &&
    descriptor.targetCohorts.every((cohort) => typeof cohort === "string") &&
    typeof descriptor.shouldForceUpdate === "boolean" &&
    (descriptor.message === null || typeof descriptor.message === "string")
  );
};

const invalidRow = (row: ReleaseCatalogPartition, reason: string) =>
  new ReleaseCatalogTilingError(
    "INVALID_PARTITION",
    `Release catalog partition ${JSON.stringify(row.lowerKey)}: ${reason}`,
  );

/**
 * A stored row, checked against what `tile` and `insert` write: one segment
 * in canonical JSON, every descriptor in its rollback list, newest first,
 * and a lower key that is its lower bound's.
 */
/**
 * A stored row as the update check reads it: as leniently as today's reader
 * of a compact row, so a 1.2.x core keeps reading rows another 1.2.x core
 * wrote. It checks the envelope, one segment with its bounds, and indexes
 * inside the descriptor list.
 */
const readPartition = (
  row: ReleaseCatalogPartition,
): {
  readonly catalog: AppVersionCatalog;
  readonly segment: CompiledCatalogSegment;
} => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    throw invalidRow(row, "the payload isn't JSON");
  }
  const catalog = parsed as AppVersionCatalog;
  const segment =
    Array.isArray(catalog?.segments) && catalog.segments.length === 1
      ? catalog.segments[0]
      : undefined;
  const inside = (indexes: unknown) =>
    Array.isArray(indexes) &&
    indexes.every(
      (index) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < catalog.releaseDescriptors.length,
    );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    catalog.schemaVersion !== RELEASE_CATALOG_SCHEMA_VERSION ||
    catalog.fallbackPolicy !== RELEASE_CATALOG_FALLBACK_POLICY ||
    catalog.strategy !== "APP_VERSION" ||
    !Array.isArray(catalog.releaseDescriptors) ||
    typeof segment !== "object" ||
    segment === null ||
    !isBound(segment.lower) ||
    !isBound(segment.upper) ||
    !inside(segment.releaseIndexes) ||
    !inside(segment.rollbackReleaseIndexes)
  ) {
    throw invalidRow(row, "the payload isn't one compiled segment");
  }
  return { catalog, segment };
};

const hasKeys = (value: object | null, count: number) =>
  value === null || Object.keys(value).length === count;

/**
 * A stored row a write builds on, checked against exactly what `tile` and
 * `insert` write: one segment in canonical JSON, every descriptor in its
 * rollback list, newest first, and a lower key that is its lower bound's.
 * A write that rewrites rows never carries a shape it doesn't know.
 */
const parsePartition = (row: ReleaseCatalogPartition): ParsedPartition => {
  const { catalog, segment } = readPartition(row);
  if (
    !hasKeys(catalog, 5) ||
    !catalog.releaseDescriptors.every(isDescriptor) ||
    !hasKeys(segment, 4) ||
    !hasKeys(segment.lower, 2) ||
    !hasKeys(segment.upper, 2) ||
    !isIndexList(segment.releaseIndexes) ||
    !isIndexList(segment.rollbackReleaseIndexes)
  ) {
    throw invalidRow(row, "the payload isn't one compiled segment");
  }
  const descriptors = catalog.releaseDescriptors;
  if (
    segment.rollbackReleaseIndexes.length !== descriptors.length ||
    segment.rollbackReleaseIndexes.some(
      (index: number, at: number) => index !== at,
    ) ||
    descriptors.some(
      (descriptor, at) =>
        at > 0 && byNewest(descriptors[at - 1]!, descriptor) >= 0,
    )
  ) {
    throw invalidRow(row, "its descriptors aren't its rollback list");
  }
  if (canonicalStringify(catalog) !== row.payload) {
    throw invalidRow(row, "the payload isn't canonical");
  }
  if (encoder.encode(row.payload).byteLength !== row.byteSize) {
    throw invalidRow(row, "its byte size isn't its payload's");
  }
  if (lowerKeyOf(segment.lower) !== row.lowerKey) {
    throw invalidRow(row, "its lower key isn't its lower bound's");
  }
  const endKey =
    segment.upper === null ? null : lowerKeyOf(after(segment.upper));
  if (segment.upper !== null && endKey === null) {
    throw invalidRow(row, "its upper bound has no key");
  }
  return { catalog, endKey, row, segment };
};

/** Rows in key order, none overlapping another. */
const parseRows = (
  partitions: readonly ReleaseCatalogPartition[],
): readonly ParsedPartition[] => {
  const rows = partitions
    .map(parsePartition)
    .sort((left, right) =>
      left.row.lowerKey < right.row.lowerKey
        ? -1
        : left.row.lowerKey > right.row.lowerKey
          ? 1
          : 0,
    );
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (
      previous !== undefined &&
      (previous.endKey === null || previous.endKey > row.row.lowerKey)
    ) {
      throw new ReleaseCatalogTilingError(
        "INVALID_TILING",
        `Release catalog partitions ${JSON.stringify(previous.row.lowerKey)} and ${JSON.stringify(row.row.lowerKey)} overlap`,
      );
    }
  });
  return rows;
};

/**
 * What a device on one app version receives from its row. Exported because
 * core's update check answers with these two lists.
 */
export interface ReleaseCatalogPartitionProjection {
  readonly releases: readonly ReleaseCatalogDescriptor[];
  readonly rollbackReleases: readonly ReleaseCatalogDescriptor[];
}

/**
 * A stored row read once, so a reader answers every app version inside it
 * without parsing it again, and checks which rows meet. Exported for core's
 * update check, its memo, and its patch-base reads.
 */
export interface ParsedReleaseCatalogPartition {
  readonly partition: ReleaseCatalogPartition;
  /** The row as a compiled catalog of its one segment. */
  readonly catalog: CompiledReleaseCatalog;
  /** The row's one segment, its bounds and its lists. */
  readonly segment: CompiledCatalogSegment;
  /** The lower key of the row after this one; null at the end of the line. */
  readonly endKey: string | null;
  /** Whether a device on `appVersion` reads this row. */
  covers(appVersion: string): boolean;
  /**
   * The two lists a device on `appVersion` receives; null when the row
   * doesn't cover it.
   */
  project(appVersion: string): ReleaseCatalogPartitionProjection | null;
}

/**
 * `partition` read as leniently as today's reader of a compact row, so a
 * 1.2.x core keeps reading rows another 1.2.x core wrote. Throws
 * `INVALID_PARTITION` when it isn't one compiled segment whose lower bound
 * is its lower key. Exported for core's reads.
 */
export function parseReleaseCatalogPartition(
  partition: ReleaseCatalogPartition,
): ParsedReleaseCatalogPartition {
  const { catalog, segment } = readPartition(partition);
  if (lowerKeyOf(segment.lower) !== partition.lowerKey) {
    throw invalidRow(partition, "its lower key isn't its lower bound's");
  }
  const endKey =
    segment.upper === null ? null : lowerKeyOf(after(segment.upper));
  if (segment.upper !== null && endKey === null) {
    throw invalidRow(partition, "its upper bound has no key");
  }
  const canonicalOf = (appVersion: string) => {
    const canonical = canonicalizeAppVersion(appVersion);
    return canonical !== null && versionInSegment(canonical, segment)
      ? canonical
      : null;
  };
  return {
    catalog,
    covers: (appVersion) => canonicalOf(appVersion) !== null,
    endKey,
    partition,
    project: (appVersion) => {
      const canonical = canonicalOf(appVersion);
      return canonical === null
        ? null
        : {
            releases: projectCompiledCatalog(catalog, canonical),
            rollbackReleases: projectCompiledRollbackCatalog(
              catalog,
              canonical,
            ),
          };
    },
    segment,
  };
}

/**
 * The two lists a device on `appVersion` receives from `partition`, as
 * `projectCompiledCatalog` and `projectCompiledRollbackCatalog` give them
 * from the compact catalog. Null when the row doesn't cover that version:
 * a lookup that found it read rows of another state, and must read again.
 * Exported for core's update check.
 */
export function projectReleaseCatalogPartition(
  partition: ReleaseCatalogPartition,
  appVersion: string,
): ReleaseCatalogPartitionProjection | null {
  const { catalog, segment } = readPartition(partition);
  const canonical = canonicalizeAppVersion(appVersion);
  if (canonical === null || !versionInSegment(canonical, segment)) return null;
  return {
    releases: projectCompiledCatalog(catalog, canonical),
    rollbackReleases: projectCompiledRollbackCatalog(catalog, canonical),
  };
}

// --- Insert -------------------------------------------------------------

/**
 * The rows of `partitions` with an enabled `release` added: each row the
 * release's range cuts is split at its endpoints, the pieces inside the
 * range gain its descriptor, and every piece's frontier is computed again.
 * Nothing merges, so the result is the rows a full compile of the scope
 * with `release` would store for the same span (an insert never merges:
 * neighbouring rows already differ, and adding one release to both sides of
 * a difference keeps it).
 *
 * `partitions` are the stored rows `releaseCatalogKeyRanges` names, or any
 * superset of them; the result replaces exactly those rows. A disabled
 * release changes nothing. Null when a new lower key doesn't fit, so the
 * scope becomes compact. Throws `INCOMPLETE_COVER` when the rows don't
 * cover the range, and `DUPLICATE_RELEASE` when a row already holds the
 * release. Exported for core's deploys and promotions.
 */
export async function insertReleaseIntoTiling(input: {
  readonly partitions: readonly ReleaseCatalogPartition[];
  readonly release: Release;
}): Promise<readonly ReleaseCatalogPartition[] | null> {
  const [release] = validateReleases([input.release], "APP_VERSION");
  const rows = parseRows(input.partitions);
  if (release === undefined) return rows.map(({ row }) => row);

  const holder = rows.find(({ catalog }) =>
    catalog.releaseDescriptors.some(
      (descriptor) => descriptor.releaseId === release.id,
    ),
  );
  if (holder !== undefined) {
    throw new ReleaseCatalogTilingError(
      "DUPLICATE_RELEASE",
      `Release ${release.id} is already in the release catalog`,
    );
  }

  const intervals = rangeToIntervals(release.targetAppVersion!);
  const ranges = releaseCatalogKeyRanges(release.targetAppVersion!);
  if (ranges === null) return null;
  for (const range of ranges) {
    let cursor: string | null = range.start;
    for (const { row, endKey } of rows) {
      if (cursor === null || (range.stop !== null && cursor >= range.stop)) {
        break;
      }
      if (endKey !== null && endKey <= cursor) continue;
      if (row.lowerKey > cursor) break;
      cursor = endKey;
    }
    if (cursor !== null && (range.stop === null || cursor < range.stop)) {
      throw new ReleaseCatalogTilingError(
        "INCOMPLETE_COVER",
        `The release catalog rows don't cover ${release.targetAppVersion}`,
      );
    }
  }

  const added = releaseDescriptor(release);
  const result: ReleaseCatalogPartition[] = [];
  for (const { row, catalog, segment } of rows) {
    const span: VersionInterval = {
      lower: segment.lower,
      upper: segment.upper,
    };
    const atoms = atomicVersionSegments([...intervals, span])
      .filter((atom) => intervalContainsSegment(span, atom))
      .map((atom) => ({
        atom,
        inside: intervals.some((interval) =>
          intervalContainsSegment(interval, atom),
        ),
      }));
    if (atoms.every(({ inside }) => !inside)) {
      result.push(row);
      continue;
    }
    // Neighbouring atoms on the same side of the range share one set.
    const pieces: { interval: VersionInterval; inside: boolean }[] = [];
    for (const { atom, inside } of atoms) {
      const previous = pieces.at(-1);
      if (previous !== undefined && previous.inside === inside) {
        previous.interval = {
          lower: previous.interval.lower,
          upper: atom.upper,
        };
      } else {
        pieces.push({ interval: atom, inside });
      }
    }
    const keys = pieces.map(({ interval }) => lowerKeyOf(interval.lower));
    if (keys.some((key) => key === null) || !keysIncrease(keys as string[])) {
      return null;
    }
    for (const [index, { interval, inside }] of pieces.entries()) {
      const descriptors = inside
        ? [added, ...catalog.releaseDescriptors].sort(byNewest)
        : catalog.releaseDescriptors;
      const frontier = collectFrontierReleaseIds(
        descriptors.map((descriptor) => ({
          bundleId: descriptor.bundleId,
          id: descriptor.releaseId,
          rolloutCohortCount: descriptor.rolloutCohortCount,
          targetCohorts: descriptor.targetCohorts,
        })),
      );
      result.push(
        await toPartition(
          keys[index]!,
          interval,
          segmentPayload(
            interval,
            descriptors,
            descriptors.flatMap((descriptor, at) =>
              frontier.has(descriptor.releaseId) ? [at] : [],
            ),
          ),
        ),
      );
    }
  }
  return result;
}

// --- Assembly -----------------------------------------------------------

/**
 * A partitioned scope's rows as the one compact catalog they tile. Exported
 * because core serves public catalog rows in this compact form.
 */
export interface ReleaseCatalogAssembly {
  readonly payload: CompiledReleaseCatalog;
  /** Byte for byte `compileReleaseCatalog`'s `canonicalPayload`. */
  readonly canonicalPayload: string;
  readonly byteSize: number;
}

/**
 * The compact catalog a tiling stands for: the non-empty rows' segments in
 * order, over the union of their descriptors indexed newest first. For the
 * tiling of a scope's releases this is exactly `compileReleaseCatalog`'s
 * payload, with no size cap. It carries no hash: a partitioned scope's
 * catalog hash is its head's, never one derived again from content.
 * Throws `INVALID_TILING` unless `partitions` tile the whole version line
 * with one descriptor per release. Exported for core's public catalog rows.
 */
export function assembleReleaseCatalog(
  partitions: readonly ReleaseCatalogPartition[],
): ReleaseCatalogAssembly {
  const rows = parseRows(partitions);
  const invalid = (reason: string) =>
    new ReleaseCatalogTilingError("INVALID_TILING", reason);
  if (rows.length === 0 || rows[0]!.segment.lower !== null) {
    throw invalid("The release catalog rows don't start the version line");
  }
  rows.forEach((row, index) => {
    const next = rows[index + 1];
    if (
      next === undefined
        ? row.endKey !== null
        : row.endKey !== next.row.lowerKey
    ) {
      throw invalid(
        `The release catalog rows leave a hole after ${JSON.stringify(row.row.lowerKey)}`,
      );
    }
  });

  const descriptors = new Map<string, ReleaseCatalogDescriptor>();
  for (const { catalog } of rows) {
    for (const descriptor of catalog.releaseDescriptors) {
      const seen = descriptors.get(descriptor.releaseId);
      if (seen === undefined) {
        descriptors.set(descriptor.releaseId, descriptor);
      } else if (canonicalStringify(seen) !== canonicalStringify(descriptor)) {
        throw invalid(
          `Release ${descriptor.releaseId} differs between release catalog rows`,
        );
      }
    }
  }
  const releaseDescriptors = [...descriptors.values()].sort(byNewest);
  const index = new Map(
    releaseDescriptors.map((descriptor, at) => [descriptor.releaseId, at]),
  );
  const segments = rows
    .filter(({ catalog }) => catalog.releaseDescriptors.length > 0)
    .map(({ catalog, segment }) => {
      const global = (local: number) =>
        index.get(catalog.releaseDescriptors[local]!.releaseId)!;
      return {
        ...segment,
        releaseIndexes: segment.releaseIndexes.map(global),
        rollbackReleaseIndexes: segment.rollbackReleaseIndexes.map(global),
      };
    });
  const payload: AppVersionCatalog = {
    fallbackPolicy: RELEASE_CATALOG_FALLBACK_POLICY,
    releaseDescriptors,
    schemaVersion: RELEASE_CATALOG_SCHEMA_VERSION,
    segments,
    strategy: "APP_VERSION",
  };
  const canonicalPayload = canonicalStringify(payload);
  return {
    byteSize: encoder.encode(canonicalPayload).byteLength,
    canonicalPayload,
    payload,
  };
}
