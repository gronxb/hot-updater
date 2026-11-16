import {
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  type Release,
} from "@hot-updater/protocol";
import { compare } from "verkit";
import { describe, expect, it } from "vitest";

import { compileReleaseCatalog } from "./releaseCatalogCompiler";
import {
  assembleReleaseCatalog,
  compileReleaseCatalogTiling,
  insertReleaseIntoTiling,
  projectReleaseCatalogPartition,
  RELEASE_CATALOG_LOWER_KEY_MAX_BYTES,
  type ReleaseCatalogPartition,
  releaseCatalogKeyRanges,
  releaseCatalogLookupKey,
  tileCompiledReleaseCatalog,
} from "./releaseCatalogTiling";

const releaseId = (sequence: number): string =>
  `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;

const release = (
  sequence: number,
  overrides: Partial<Release> = {},
): Release => ({
  bundleId: `00000000-0000-7001-8000-${String(sequence).padStart(12, "0")}`,
  channelId: "channel-production",
  createdAtMs: sequence,
  enabled: true,
  fingerprintHash: null,
  id: releaseId(sequence),
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rolloutCohortCount: 1000,
  shouldForceUpdate: false,
  sourceReleaseId: null,
  strategy: "APP_VERSION",
  targetAppVersion: "1.0.0",
  targetCohorts: [],
  updatedAtMs: sequence,
  ...overrides,
});

const tiling = async (releases: readonly Release[]) => {
  const rows = await compileReleaseCatalogTiling({ releases });
  expect(rows).not.toBeNull();
  return rows!;
};

const bounds = (rows: readonly ReleaseCatalogPartition[]) =>
  rows.map((row) => {
    const segment = JSON.parse(row.payload).segments[0];
    const lower = segment.lower;
    const upper = segment.upper;
    return `${lower === null ? "(-inf" : `${lower.inclusive ? "[" : "("}${lower.version}`},${
      upper === null ? "inf)" : `${upper.version}${upper.inclusive ? "]" : ")"}`
    }`;
  });

// --- Lower keys -------------------------------------------------------------

type Bound = { readonly version: string; readonly inclusive: boolean };

const NUMBERS = [
  "0",
  "1",
  "2",
  "9",
  "10",
  "11",
  "99",
  "100",
  "123456789012345",
];
const IDENTIFIERS = [
  "0",
  "1",
  "2",
  "9",
  "10",
  "11",
  "999999999999999",
  "alpha",
  "beta",
  "beta1",
  "1a",
  "rc",
  "a",
  "ab",
  "abc",
  "A",
  "Z",
  "a-b",
  "x-",
];

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** Versions from a grammar: multi-digit fields, prereleases of 0–3 identifiers. */
const generateVersions = (count: number): readonly string[] => {
  const random = createRandom(7);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const versions = new Set<string>([
    "1.9.0",
    "1.10.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "9007199254740991.0.0",
  ]);
  while (versions.size < count) {
    const main = [pick(NUMBERS), pick(NUMBERS), pick(NUMBERS)].join(".");
    const length = Math.floor(random() * 4);
    const prerelease = Array.from({ length }, () => pick(IDENTIFIERS));
    versions.add(length === 0 ? main : `${main}-${prerelease.join(".")}`);
  }
  return [...versions];
};

const compareBounds = (left: Bound, right: Bound): number =>
  compare(left.version, right.version) ||
  (left.inclusive === right.inclusive ? 0 : left.inclusive ? -1 : 1);

/** Every pair whose key order differs from the compiler's bound order. */
const orderViolations = (
  versions: readonly string[],
  keyOf: (bound: Bound) => string,
): readonly string[] => {
  const all = versions.flatMap((version) => [
    { inclusive: true, version },
    { inclusive: false, version },
  ]);
  const keys = all.map(keyOf);
  const violations: string[] = [];
  for (let left = 0; left < all.length; left += 1) {
    for (let right = 0; right < all.length; right += 1) {
      const expected = Math.sign(compareBounds(all[left]!, all[right]!));
      const actual = Math.sign(
        keys[left]! < keys[right]! ? -1 : keys[left]! > keys[right]! ? 1 : 0,
      );
      if (expected !== actual) {
        violations.push(
          `${JSON.stringify(all[left])} vs ${JSON.stringify(all[right])}`,
        );
      }
    }
  }
  return violations;
};

const kitKey = ({ inclusive, version }: Bound): string => {
  const ranges = releaseCatalogKeyRanges(`${inclusive ? ">=" : ">"}${version}`);
  expect(ranges, version).not.toBeNull();
  return ranges![0]!.start;
};

describe("lower keys", () => {
  const versions = generateVersions(220);

  it("order bytewise exactly as verkit compare orders lower bounds", () => {
    expect(orderViolations(versions, kitKey)).toEqual([]);
  });

  it("are red against a naive dotted key, which puts 1.10.0 before 1.9.0", () => {
    const naive = ({ inclusive, version }: Bound) =>
      `${version}${inclusive ? "=" : ">"}`;
    const violations = orderViolations(versions, naive);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain(
      `${JSON.stringify({ inclusive: true, version: "1.9.0" })} vs ${JSON.stringify({ inclusive: true, version: "1.10.0" })}`,
    );
  });

  it("look a device version up by its inclusive key", () => {
    expect(releaseCatalogLookupKey("1.2.3")).toBe(
      kitKey({ inclusive: true, version: "1.2.3" }),
    );
    expect(releaseCatalogLookupKey("v1.2")).toBe(
      kitKey({ inclusive: true, version: "1.2.0" }),
    );
    expect(releaseCatalogLookupKey("not a version")).toBeNull();
  });

  it("are null for a version compare can't tell apart exactly, or one too long for the column", async () => {
    // Above the largest safe integer, verkit compares digit identifiers
    // through Number and loses digits.
    expect(releaseCatalogKeyRanges(">=1.0.0-9007199254740993")).toBeNull();
    // verkit takes versions of up to 256 characters; this one's key is 259.
    const long = `1.0.0-${"a".repeat(248)}`;
    expect(releaseCatalogKeyRanges(`>=${long}`)).toBeNull();
    expect(
      kitKey({ inclusive: true, version: `1.0.0-${"a".repeat(200)}` }).length,
    ).toBeLessThanOrEqual(RELEASE_CATALOG_LOWER_KEY_MAX_BYTES);
    // So the scope stays compact, and inserting such a range makes it so.
    expect(
      await compileReleaseCatalogTiling({
        releases: [release(1, { targetAppVersion: `>=${long}` })],
      }),
    ).toBeNull();
    expect(
      await insertReleaseIntoTiling({
        partitions: await tiling([]),
        release: release(1, { targetAppVersion: `>=${long}` }),
      }),
    ).toBeNull();
  });
});

// --- Tiling and assembly ----------------------------------------------------

describe("compileReleaseCatalogTiling", () => {
  it("tiles an empty scope with one gap row that answers empty lists", async () => {
    const rows = await tiling([]);
    expect(bounds(rows)).toEqual(["(-inf,inf)"]);
    expect(projectReleaseCatalogPartition(rows[0]!, "1.0.0")).toEqual({
      releases: [],
      rollbackReleases: [],
    });
  });

  it("fills every gap, at both ends and between exact versions", async () => {
    const rows = await tiling([
      release(1, { targetAppVersion: "1.0.0" }),
      release(2, { targetAppVersion: "2.0.0" }),
    ]);
    expect(bounds(rows)).toEqual([
      "(-inf,1.0.0)",
      "[1.0.0,1.0.0]",
      "(1.0.0,2.0.0)",
      "[2.0.0,2.0.0]",
      "(2.0.0,inf)",
    ]);
    const keys = rows.map(({ lowerKey }) => lowerKey);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cuts at each endpoint of overlapping, open, union and prerelease ranges", async () => {
    const rows = await tiling([
      release(1, { targetAppVersion: ">=1.2.0" }),
      release(2, { targetAppVersion: "<1.5.0" }),
      release(3, { targetAppVersion: "1.0.0 || 1.7.0" }),
      release(4, { targetAppVersion: ">=1.3.0-beta.1 <1.3.0" }),
    ]);
    expect(bounds(rows)).toEqual([
      "(-inf,1.0.0)",
      "[1.0.0,1.0.0]",
      "(1.0.0,1.2.0)",
      "[1.2.0,1.3.0-beta.1)",
      "[1.3.0-beta.1,1.3.0)",
      "[1.3.0,1.5.0)",
      "[1.5.0,1.7.0)",
      "[1.7.0,1.7.0]",
      "(1.7.0,inf)",
    ]);
  });

  it("assembles to the compiler's canonical payload, and converts it back", async () => {
    const releases = [
      release(1, { targetAppVersion: ">=1.2.0", rolloutCohortCount: 10 }),
      release(2, { targetAppVersion: "<1.5.0", targetCohorts: ["qa"] }),
      release(3, { targetAppVersion: "1.0.0 || 1.7.0", enabled: false }),
      release(4, { targetAppVersion: "2.x", shouldForceUpdate: true }),
    ];
    const compiled = await compileReleaseCatalog({
      releases,
      strategy: "APP_VERSION",
    });
    const rows = await tiling(releases);
    expect(assembleReleaseCatalog(rows)).toEqual({
      byteSize: compiled.byteSize,
      canonicalPayload: compiled.canonicalPayload,
      payload: compiled.payload,
    });
    expect(await tileCompiledReleaseCatalog(compiled.payload)).toEqual(rows);
  });

  it("refuses a FINGERPRINT catalog, which stays one row", async () => {
    const compiled = await compileReleaseCatalog({
      releases: [
        release(1, {
          fingerprintHash: "fingerprint-a",
          strategy: "FINGERPRINT",
          targetAppVersion: null,
        }),
      ],
      strategy: "FINGERPRINT",
    });
    await expect(
      tileCompiledReleaseCatalog(compiled.payload),
    ).rejects.toMatchObject({ code: "FINGERPRINT_NOT_PARTITIONED" });
  });

  it("refuses a stored compact payload that isn't the compiler's", async () => {
    const compiled = await compileReleaseCatalog({
      releases: [release(1), release(2, { targetAppVersion: "2.0.0" })],
      strategy: "APP_VERSION",
    });
    const payload = compiled.payload as Extract<
      typeof compiled.payload,
      { strategy: "APP_VERSION" }
    >;
    // A segment the compiler would have split in two.
    await expect(
      tileCompiledReleaseCatalog({
        ...payload,
        segments: [
          { ...payload.segments[0]!, upper: payload.segments[1]!.upper },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_TILING" });
  });
});

describe("per-row caps", () => {
  const sized = (sequence: number, version: string, length: number) =>
    release(sequence, {
      message: "m".repeat(length),
      targetAppVersion: version,
    });

  it("accepts a scope over 256 KB in total, and refuses one row over it, naming its versions", async () => {
    const spread = [
      sized(1, "1.0.0", 100_000),
      sized(2, "2.0.0", 100_000),
      sized(3, "3.0.0", 100_000),
    ];
    await expect(
      compileReleaseCatalog({ releases: spread, strategy: "APP_VERSION" }),
    ).rejects.toMatchObject({ code: "CATALOG_OVERSIZE" });
    await tiling(spread);
    await expect(
      compileReleaseCatalogTiling({
        releases: [
          sized(1, "1.0.0", 100_000),
          sized(2, "1.0.0", 100_000),
          sized(3, "1.0.0", 100_000),
        ],
      }),
    ).rejects.toMatchObject({
      code: "CATALOG_OVERSIZE",
      message: expect.stringContaining("[1.0.0, 1.0.0]"),
    });
  });

  it("holds a row at exactly 256 KB and refuses one byte more", async () => {
    const [, base] = await tiling([sized(1, "1.0.0", 0)]);
    const length = MAX_COMPILED_CATALOG_BYTES - base!.byteSize;
    const [, exact] = await tiling([sized(1, "1.0.0", length)]);
    expect(exact!.byteSize).toBe(MAX_COMPILED_CATALOG_BYTES);
    await expect(
      compileReleaseCatalogTiling({
        releases: [sized(1, "1.0.0", length + 1)],
      }),
    ).rejects.toMatchObject({ code: "CATALOG_OVERSIZE" });
  });

  it("counts distinct target cohorts per row: 512 hold, 513 refuse", async () => {
    const cohorts = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `c${from + index}`);
    const withCohorts = (total: number, version: (index: number) => string) =>
      Array.from({ length: Math.ceil(total / 100) }, (_, index) =>
        release(index + 1, {
          targetAppVersion: version(index),
          targetCohorts: cohorts(
            index * 100,
            Math.min(100, total - index * 100),
          ),
        }),
      );
    const limit = MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE;
    await tiling(withCohorts(limit, () => "1.0.0"));
    await expect(
      compileReleaseCatalogTiling({
        releases: withCohorts(limit + 1, () => "1.0.0"),
      }),
    ).rejects.toMatchObject({ code: "DISTINCT_TARGET_COHORT_LIMIT" });
    // Spread over two versions, 513 is refused today and fits the tiling.
    const spread = withCohorts(limit + 1, (index) =>
      index < 3 ? "1.0.0" : "2.0.0",
    );
    await expect(
      compileReleaseCatalog({ releases: spread, strategy: "APP_VERSION" }),
    ).rejects.toMatchObject({ code: "DISTINCT_TARGET_COHORT_LIMIT" });
    await tiling(spread);
  });
});

// --- Insert -----------------------------------------------------------------

describe("insertReleaseIntoTiling", () => {
  const base = [
    release(1, { targetAppVersion: "1.0.0" }),
    release(2, { targetAppVersion: ">=1.2.0 <1.4.0" }),
  ];

  it("equals a full compile, cutting only the rows the range covers", async () => {
    const rows = await tiling(base);
    const added = release(3, { targetAppVersion: ">1.3.0 <=2.0.0" });
    const ranges = releaseCatalogKeyRanges(added.targetAppVersion!)!;
    const read = rows.filter(
      (row, index) =>
        (row.lowerKey <= ranges[0]!.start &&
          (rows[index + 1]?.lowerKey ?? "~") > ranges[0]!.start) ||
        (row.lowerKey > ranges[0]!.start && row.lowerKey < ranges[0]!.stop!),
    );
    expect(bounds(read)).toEqual(["[1.2.0,1.4.0)", "[1.4.0,inf)"]);
    const written = await insertReleaseIntoTiling({
      partitions: read,
      release: added,
    });
    const untouched = rows.filter((row) => !read.includes(row));
    expect(
      [...untouched, ...written!].sort((left, right) =>
        left.lowerKey < right.lowerKey ? -1 : 1,
      ),
    ).toEqual(await tiling([...base, added]));
  });

  it("refuses rows that don't cover the range", async () => {
    const rows = await tiling(base);
    await expect(
      insertReleaseIntoTiling({
        partitions: rows.slice(0, 2),
        release: release(3, { targetAppVersion: ">=1.0.0" }),
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_COVER" });
  });

  it("refuses a release a row already holds", async () => {
    const rows = await tiling(base);
    await expect(
      insertReleaseIntoTiling({ partitions: rows, release: base[0]! }),
    ).rejects.toMatchObject({ code: "DUPLICATE_RELEASE" });
  });

  it("changes nothing for a disabled release", async () => {
    const rows = await tiling(base);
    expect(
      await insertReleaseIntoTiling({
        partitions: rows,
        release: release(3, { enabled: false, targetAppVersion: "*" }),
      }),
    ).toEqual(rows);
  });
});

// --- Stored rows ------------------------------------------------------------

describe("stored rows", () => {
  it("project only the versions a row covers", async () => {
    const rows = await tiling([release(1, { targetAppVersion: "1.0.0" })]);
    const exact = rows[1]!;
    expect(
      projectReleaseCatalogPartition(exact, "1.0.0")?.releases,
    ).toHaveLength(1);
    // A row read for another version looks like a torn read, not a gap.
    expect(projectReleaseCatalogPartition(exact, "1.0.1")).toBeNull();
    expect(projectReleaseCatalogPartition(exact, "garbage")).toBeNull();
  });

  it("are read for the update check as leniently as a compact row", async () => {
    const rows = await tiling([release(1, { targetAppVersion: "1.0.0" })]);
    const row = rows[1]!;
    // A field another 1.2.x core might add doesn't stop this one reading.
    const extended = JSON.parse(row.payload);
    extended.segments[0].note = "added later";
    extended.releaseDescriptors[0].note = "added later";
    expect(
      projectReleaseCatalogPartition(
        { ...row, payload: JSON.stringify(extended) },
        "1.0.0",
      )?.releases,
    ).toHaveLength(1);
    for (const payload of [
      "{",
      row.payload.replace('"APP_VERSION"', '"FINGERPRINT"'),
      row.payload.replace('"releaseIndexes":[0]', '"releaseIndexes":[1]'),
    ]) {
      expect(() =>
        projectReleaseCatalogPartition({ ...row, payload }, "1.0.0"),
      ).toThrow(expect.objectContaining({ code: "INVALID_PARTITION" }));
    }
  });

  it("refuse, for a write, any row that isn't exactly what the kit writes", async () => {
    const rows = await tiling([release(1, { targetAppVersion: "1.0.0" })]);
    const row = rows[1]!;
    const extended = JSON.parse(row.payload);
    extended.segments[0].note = "added later";
    const tampered: ReleaseCatalogPartition[] = [
      { ...row, payload: row.payload.replace("1.0.0", "1.0.1") },
      { ...row, lowerKey: `${row.lowerKey}0` },
      { ...row, payload: ` ${row.payload}`, byteSize: row.byteSize + 1 },
      { ...row, byteSize: row.byteSize + 1 },
      { ...row, payload: "{" },
      { ...row, payload: JSON.stringify(extended) },
    ];
    for (const partition of tampered) {
      expect(() =>
        assembleReleaseCatalog([rows[0]!, partition, rows[2]!]),
      ).toThrow(expect.objectContaining({ code: "INVALID_PARTITION" }));
      await expect(
        insertReleaseIntoTiling({
          partitions: [rows[0]!, partition, rows[2]!],
          release: release(2, { targetAppVersion: "*" }),
        }),
      ).rejects.toMatchObject({ code: "INVALID_PARTITION" });
    }
  });

  it("assemble only a whole tiling with one descriptor per release", async () => {
    const releases = [
      release(1, { targetAppVersion: ">=1.0.0" }),
      release(2, { targetAppVersion: "2.0.0" }),
    ];
    const rows = await tiling(releases);
    expect(() => assembleReleaseCatalog(rows.slice(1))).toThrow(
      expect.objectContaining({ code: "INVALID_TILING" }),
    );
    expect(() =>
      assembleReleaseCatalog([...rows.slice(0, 2), ...rows.slice(3)]),
    ).toThrow(expect.objectContaining({ code: "INVALID_TILING" }));
    expect(() => assembleReleaseCatalog([...rows, rows[1]!])).toThrow(
      expect.objectContaining({ code: "INVALID_TILING" }),
    );
    // One release edited in one row only.
    const edited = await tiling([
      release(1, { message: "edited", targetAppVersion: ">=1.0.0" }),
      releases[1]!,
    ]);
    expect(() =>
      assembleReleaseCatalog([...rows.slice(0, 2), ...edited.slice(2)]),
    ).toThrow(expect.objectContaining({ code: "INVALID_TILING" }));
  });
});
