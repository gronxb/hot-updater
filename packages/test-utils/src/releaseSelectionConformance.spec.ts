import {
  authorizeReleaseTransition,
  MAX_RELEASE_CATALOG_WIRE_BYTES,
  canonicalizeAppVersion,
  createReleaseCatalogScopeKey,
  createReleaseSelectionContextHash,
  encodeChannelKey,
  type ExpectedReleaseCatalogScope,
  isReleaseEligibleForCohort,
  normalizeCohortValue,
  parseReleaseCatalog,
  parseReleaseCatalogScopeKey,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
  type ReleaseCatalogScopeKeyInput,
  selectDesiredRelease,
  type ReleaseSelectionInput,
} from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

/**
 * The Swift and Kotlin release selectors in @hot-updater/react-native read this
 * file and must return the same results as @hot-updater/protocol. Run
 * `vitest -u` on this spec after changing the protocol's selection logic, then
 * update both native ports until their conformance tests pass.
 */
const FIXTURE_PATH = "../fixtures/release-selection-conformance.json";

// Mulberry32: a small deterministic generator, so the fixture is stable.
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

const NIL = "00000000-0000-0000-0000-000000000000";
const hex = (value: number, length: number) =>
  value.toString(16).padStart(length, "0");
/** A UUIDv7 whose order follows `index`. */
const uuid = (index: number) =>
  `${hex(0x01900000 + index * 16, 8)}-0000-7000-8000-${hex(index, 12)}`;

const errorOf = <T>(run: () => T): { value: T } | { error: true } => {
  try {
    return { value: run() };
  } catch {
    return { error: true };
  }
};

const appVersionCases = [
  "1",
  "1.4",
  "v1.4",
  "1.4.0",
  "1.4.0-beta.1",
  "1.4.0+42",
  "Version 2.10.3 (build 7)",
  "  3.2.1  ",
  "01.2.3",
  "1.02",
  "0.0.0",
  "10.20.30.40",
  "9007199254740991",
  "9007199254740992",
  "12345678901234567",
  "1234567890123456.1",
  "abc",
  "",
  "v",
  "1..2",
  "release-2026.10",
  "١.٢.٣",
  "4.5.6a",
  "a7.8.9",
].map((input) => ({ input, output: canonicalizeAppVersion(input) }));

const channels = [
  "production",
  "ota-test",
  "beta",
  "Production",
  "프로덕션",
  "채널 1",
  "emoji-🚀",
  "café",
  "café",
  " production",
  "production ",
  "",
  "a".repeat(255),
  "a".repeat(256),
  "/slash?query#hash",
  "tab\tinside",
];
const channelKeyCases = channels.map((channel) => ({
  channel,
  ...errorOf(() => encodeChannelKey(channel)),
}));

const fingerprintHashes = [
  "bab42890eeae52e182f8eec84007bb3cbc94d227",
  "a.b_c~d-e",
  "with:colon",
  "",
  "x".repeat(255),
  "x".repeat(256),
];
const scopeCreateCases = [
  ...["ios", "android"].flatMap((platform) =>
    ["production", "프로덕션", "beta"].map((channel) => ({
      channelKey: encodeChannelKey(channel),
      platform,
      strategy: "APP_VERSION",
    })),
  ),
  ...fingerprintHashes.map((fingerprintHash) => ({
    channelKey: encodeChannelKey("production"),
    fingerprintHash,
    platform: "android",
    strategy: "FINGERPRINT",
  })),
  {
    channelKey: "not+canonical",
    platform: "ios",
    strategy: "APP_VERSION",
  },
  {
    channelKey: "cHJvZHVjdGlvbg=",
    platform: "ios",
    strategy: "APP_VERSION",
  },
].map((input) => ({
  input,
  ...errorOf(() =>
    createReleaseCatalogScopeKey(input as ReleaseCatalogScopeKeyInput),
  ),
}));
const scopeParseCases = [
  "v1:app-version:ios:cHJvZHVjdGlvbg",
  "v1:fingerprint:android:cHJvZHVjdGlvbg:abc123",
  "v1:app-version:web:cHJvZHVjdGlvbg",
  "v2:app-version:ios:cHJvZHVjdGlvbg",
  "v1:app-version:ios:cHJvZHVjdGlvbg:extra",
  "v1:fingerprint:ios:cHJvZHVjdGlvbg",
  "v1:fingerprint:ios:cHJvZHVjdGlvbg:",
  "v1:app-version:ios:",
  "v1:app-version:ios:IHByb2R1Y3Rpb24",
  "",
].map((scopeKey) => ({
  scopeKey,
  ...errorOf(() => parseReleaseCatalogScopeKey(scopeKey)),
}));

const cohortInputs = [
  "1",
  "001",
  "42",
  "1000",
  "1001",
  "0",
  "-1",
  "qa",
  " QA ",
  " beta ",
  "﻿beta",
  "Beta-2",
  "beta_2",
  "a".repeat(64),
  "a".repeat(65),
  "",
  "ΑΣ",
  "İstanbul",
  "1.5",
];
const normalizeCohortCases = cohortInputs.map((input) => ({
  input,
  output: normalizeCohortValue(input),
}));

const eligibilityRandom = createRandom(546);
const rolloutCounts = [0, 1, 7, 250, 500, 999, 1000, 1500, -3, 12.7];
const targetCohortSets = [[], ["qa"], ["42"], ["QA ", "beta"], ["1000"]];
const eligibilityCohorts: (string | null)[] = [
  null,
  "1",
  "2",
  "42",
  "500",
  "999",
  "1000",
  "qa",
  "beta",
  "QA",
  "1001",
];
const eligibilityCases = Array.from({ length: 400 }, (_, index) => {
  const release = {
    releaseId: uuid(Math.floor(eligibilityRandom() * 5000)),
    rolloutCohortCount: rolloutCounts[index % rolloutCounts.length]!,
    targetCohorts:
      targetCohortSets[
        Math.floor(eligibilityRandom() * targetCohortSets.length)
      ]!,
  };
  const cohort =
    eligibilityCohorts[
      Math.floor(eligibilityRandom() * eligibilityCohorts.length)
    ]!;
  return {
    ...release,
    cohort,
    eligible: isReleaseEligibleForCohort(release, cohort),
  };
});

const hashInputs = [
  {
    cohort: "42",
    crashedBundleIds: [],
    minimumReleaseId: NIL,
    strategy: "APP_VERSION",
    strategyValue: "1.4.0",
  },
  {
    activeBundleId: uuid(3),
    activeReleaseId: uuid(4),
    cohort: " QA ",
    crashedBundleIds: [uuid(9), uuid(1), uuid(9), uuid(5)],
    minimumReleaseId: uuid(0),
    strategy: "FINGERPRINT",
    strategyValue: "bab42890eeae52e182f8eec84007bb3cbc94d227",
  },
  {
    activeBundleId: null,
    activeReleaseId: null,
    cohort: null,
    crashedBundleIds: Array.from({ length: 14 }, (_, index) =>
      uuid(20 - index),
    ),
    minimumReleaseId: uuid(0),
    strategy: "APP_VERSION",
    strategyValue: "2.0.0",
  },
  {
    cohort: 'quote"back\\slash/solidus\u0001\n\t emoji🚀é',
    crashedBundleIds: ['id"with"quotes', "\u001f", "Ω"],
    minimumReleaseId: "\u007f\u0080",
    strategy: "FINGERPRINT",
    strategyValue: "\ud83d\ude80",
  },
  {
    activeBundleId: "é",
    cohort: " Beta ",
    crashedBundleIds: ["B", "a", "A", "b"],
    minimumReleaseId: NIL,
    strategy: "APP_VERSION",
    strategyValue: "0.0.1",
  },
].map((input) => ({
  input,
  hash: createReleaseSelectionContextHash(
    input as Parameters<typeof createReleaseSelectionContextHash>[0],
  ),
}));

const appVersionScope: ExpectedReleaseCatalogScope = {
  channelKey: encodeChannelKey("production"),
  platform: "ios",
  strategy: "APP_VERSION",
};
const fingerprintScope: ExpectedReleaseCatalogScope = {
  channelKey: encodeChannelKey("production"),
  fingerprintHash: "abc123",
  platform: "android",
  strategy: "FINGERPRINT",
};
const descriptor = (
  index: number,
  overrides: Partial<ReleaseCatalogDescriptor> = {},
): ReleaseCatalogDescriptor => ({
  bundleId: uuid(index + 1000),
  kind: "BUNDLE",
  message: null,
  releaseId: uuid(index),
  rolloutCohortCount: 1000,
  shouldForceUpdate: false,
  targetCohorts: [],
  ...overrides,
});
const validCatalog = (
  scope: ExpectedReleaseCatalogScope,
  overrides: Record<string, unknown> = {},
) => ({
  catalogHash: `sha256:${"a".repeat(64)}`,
  catalogId: "catalog-1",
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 3,
  releases: [descriptor(3, { message: "Fix" }), descriptor(2)],
  rollbackReleases: [descriptor(2), descriptor(1, { shouldForceUpdate: true })],
  schemaVersion: 1,
  scopeKey: createReleaseCatalogScopeKey(scope as ReleaseCatalogScopeKeyInput),
  ...overrides,
});
const bodyCases: {
  name: string;
  body: string;
  scope: ExpectedReleaseCatalogScope;
}[] = [
  {
    name: "valid app-version catalog",
    body: JSON.stringify(validCatalog(appVersionScope)),
    scope: appVersionScope,
  },
  {
    name: "valid fingerprint catalog",
    body: JSON.stringify(validCatalog(fingerprintScope)),
    scope: fingerprintScope,
  },
  {
    name: "unknown fields are accepted",
    body: JSON.stringify({ ...validCatalog(appVersionScope), extra: true }),
    scope: appVersionScope,
  },
  {
    name: "generation written as 3.0",
    body: JSON.stringify(validCatalog(appVersionScope)).replace(
      '"generation":3',
      '"generation":3.0',
    ),
    scope: appVersionScope,
  },
  {
    name: "generation written as 3e0",
    body: JSON.stringify(validCatalog(appVersionScope)).replace(
      '"generation":3',
      '"generation":3e0',
    ),
    scope: appVersionScope,
  },
  ...[
    ["schemaVersion", 2],
    ["catalogId", ""],
    ["catalogId", 5],
    ["generation", 0],
    ["generation", 1.5],
    ["generation", 9007199254740992],
    ["generation", "3"],
    ["catalogHash", "sha256:ABC"],
    ["catalogHash", `sha256:${"g".repeat(64)}`],
    ["fallbackPolicy", "NONE"],
    ["releases", null],
    ["rollbackReleases", {}],
  ].map(([field, value]) => ({
    name: `invalid ${String(field)} ${JSON.stringify(value)}`,
    body: JSON.stringify(
      validCatalog(appVersionScope, { [field as string]: value }),
    ),
    scope: appVersionScope,
  })),
  ...[
    ["releaseId", "not-a-uuid"],
    ["releaseId", uuid(5).replace("-7000-", "-4000-")],
    ["kind", "BUILTIN"],
    ["bundleId", null],
    ["rolloutCohortCount", 1001],
    ["rolloutCohortCount", -1],
    ["rolloutCohortCount", 2.5],
    ["rolloutCohortCount", true],
    ["targetCohorts", "qa"],
    ["targetCohorts", [1]],
    ["targetCohorts", Array.from({ length: 101 }, (_, index) => `c${index}`)],
    ["shouldForceUpdate", 0],
    ["message", 1],
  ].map(([field, value]) => ({
    name: `invalid release ${String(field)} ${JSON.stringify(value).slice(0, 40)}`,
    body: JSON.stringify(
      validCatalog(appVersionScope, {
        releases: [descriptor(3, { [field as string]: value } as never)],
      }),
    ),
    scope: appVersionScope,
  })),
  {
    name: "too many distinct target cohorts",
    body: JSON.stringify(
      validCatalog(appVersionScope, {
        releases: Array.from({ length: 6 }, (_, release) =>
          descriptor(release, {
            targetCohorts: Array.from(
              { length: 90 },
              (_, index) => `c${release}-${index}`,
            ),
          }),
        ),
      }),
    ),
    scope: appVersionScope,
  },
  {
    name: "scope of another channel",
    body: JSON.stringify(validCatalog(appVersionScope)),
    scope: { ...appVersionScope, channelKey: encodeChannelKey("beta") },
  },
  {
    name: "scope of another platform",
    body: JSON.stringify(validCatalog(appVersionScope)),
    scope: { ...appVersionScope, platform: "android" },
  },
  {
    name: "scope of another fingerprint",
    body: JSON.stringify(validCatalog(fingerprintScope)),
    scope: { ...fingerprintScope, fingerprintHash: "other" },
  },
  {
    name: "app-version catalog for a fingerprint request",
    body: JSON.stringify(validCatalog(appVersionScope)),
    scope: { ...fingerprintScope, platform: "ios" },
  },
  { name: "not JSON", body: "{", scope: appVersionScope },
  // Syntax lenient parsers accept and JSON.parse rejects.
  ...(
    [
      ["single-quoted strings", (body: string) => body.replaceAll('"', "'")],
      [
        "unquoted key",
        (body: string) => body.replace('"catalogId"', "catalogId"),
      ],
      ["comment", (body: string) => `/* catalog */${body}`],
      [
        "trailing comma in an object",
        (body: string) => body.replace(/}$/, ",}"),
      ],
      [
        "trailing comma in an array",
        (body: string) =>
          body.replace('"targetCohorts":[]', '"targetCohorts":[1,]'),
      ],
      [
        "hexadecimal number",
        (body: string) => body.replace('"generation":3', '"generation":0x3'),
      ],
      [
        "leading zero",
        (body: string) => body.replace('"generation":3', '"generation":03'),
      ],
      [
        "NaN",
        (body: string) => body.replace('"generation":3', '"generation":NaN'),
      ],
      [
        "unescaped control character",
        // A raw tab inside a string.
        (body: string) => body.replace('"Fix"', '"F\tix"'),
      ],
    ] as const
  ).map(([name, rewrite]) => ({
    name,
    body: rewrite(JSON.stringify(validCatalog(appVersionScope))),
    scope: appVersionScope,
  })),
  { name: "JSON array", body: "[]", scope: appVersionScope },
  { name: "JSON null", body: "null", scope: appVersionScope },
];
const parseCatalogCases = bodyCases.map(({ name, body, scope }) => ({
  name,
  body,
  expectedScope: scope,
  catalog: parseReleaseCatalog(body, scope),
}));

// Selection compares IDs only by their order, so short sortable IDs keep the
// fixture small: r#### for Releases, b#### for bundles.
const releaseIdOf = (index: number) => `r${String(index).padStart(4, "0")}`;
const bundleIdOf = (index: number) => `b${String(index).padStart(4, "0")}`;
const selectionRandom = createRandom(1524);
const pick = <T>(values: readonly T[]): T =>
  values[Math.floor(selectionRandom() * values.length)]!;
const subset = <T>(values: readonly T[]): T[] =>
  values.filter(() => selectionRandom() < 0.5);
const selectionCases = Array.from({ length: 400 }, (_, index) => {
  const poolSize = 1 + Math.floor(selectionRandom() * 7);
  const pool = Array.from({ length: poolSize }, (_, position) => {
    const releaseIndex = 10 + position * 2;
    return descriptor(releaseIndex, {
      releaseId: releaseIdOf(releaseIndex),
      bundleId:
        selectionRandom() < 0.08 ? null : bundleIdOf(releaseIndex + 1000),
      rolloutCohortCount: pick([0, 1, 250, 500, 999, 1000, 1000, 1000]),
      shouldForceUpdate: selectionRandom() < 0.3,
      targetCohorts: pick([[], [], ["qa"], ["42"], ["qa", "beta"]]),
    });
  });
  // Pool indexes, newest first: the fixture stores each descriptor once.
  const newestFirstIndexes = () =>
    pool
      .map((_, position) => position)
      .filter(() => selectionRandom() < 0.5)
      .reverse();
  const releases = newestFirstIndexes();
  const rollbackReleases = newestFirstIndexes();
  const catalog: ReleaseCatalog = {
    catalogHash: `sha256:${"b".repeat(64)}`,
    catalogId: "catalog-1",
    fallbackPolicy:
      index % 50 === 49
        ? ("NONE" as "BUILTIN_IF_ACTIVE_INELIGIBLE")
        : "BUILTIN_IF_ACTIVE_INELIGIBLE",
    generation: 1,
    releases: releases.map((position) => pool[position]!),
    rollbackReleases: rollbackReleases.map((position) => pool[position]!),
    schemaVersion: 1,
    scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
  };
  const minimumReleaseId = pick([
    bundleIdOf(0),
    bundleIdOf(1),
    bundleIdOf(1015),
  ]);
  const bundleIds = pool
    .map((release) => release.bundleId)
    .filter((bundleId): bundleId is string => bundleId !== null);
  const currentBundleId =
    selectionRandom() < 0.3
      ? minimumReleaseId
      : pick([...bundleIds, ...bundleIds, bundleIdOf(5000)]);
  const releaseIds = pool.map((release) => release.releaseId);
  const activeReleaseId =
    selectionRandom() < 0.3
      ? null
      : pick([...releaseIds, ...releaseIds, releaseIdOf(9)]);
  const runningReleaseChoice = pick([
    "absent",
    "absent",
    "null",
    ...releaseIds,
  ]);
  const input: ReleaseSelectionInput = {
    activeReleaseId,
    builtInBundleId: minimumReleaseId,
    cohort: pick([null, "1", "42", "500", "1000", "qa", "beta", " QA "]),
    crashedBundleIds: subset(bundleIds).slice(0, 2),
    currentBundleId,
    minimumReleaseId,
    ...(runningReleaseChoice === "absent"
      ? {}
      : {
          runningReleaseId:
            runningReleaseChoice === "null" ? null : runningReleaseChoice,
        }),
  };
  const desired = selectDesiredRelease(catalog, input);
  // Every other catalog field is the same in each case:
  // schemaVersion 1, catalogId "catalog-1", generation 1.
  return {
    pool,
    releases,
    rollbackReleases,
    fallbackPolicy: catalog.fallbackPolicy,
    input,
    desired:
      desired === null
        ? null
        : {
            bundleId: desired.bundleId,
            kind: desired.kind,
            releaseId: desired.releaseId,
            shouldForceUpdate: desired.shouldForceUpdate,
            status: desired.status,
          },
  };
});

const authorizeRandom = createRandom(1528);
const chance = (probability: number) => authorizeRandom() < probability;
const oneOf = <T>(values: readonly T[]): T =>
  values[Math.floor(authorizeRandom() * values.length)]!;
const receipt = (): PersistedSelectionReceipt => {
  const builtIn = chance(0.15);
  return {
    bundleId: bundleIdOf(Math.floor(authorizeRandom() * 4)),
    catalogHash: chance(0.1) ? null : "sha256:x",
    catalogId: chance(0.1)
      ? null
      : oneOf(["catalog-0", "catalog-0", "catalog-1"]),
    channel: "production",
    generation: chance(0.1) ? null : oneOf([1, 2, 2, 3]),
    kind: builtIn ? "BUILTIN" : "BUNDLE",
    releaseId:
      builtIn || chance(0.1)
        ? null
        : releaseIdOf(Math.floor(authorizeRandom() * 4)),
    scopeKey: chance(0.1)
      ? null
      : oneOf([
          "v1:app-version:ios:cHJvZHVjdGlvbg",
          "v1:app-version:ios:cHJvZHVjdGlvbg",
          "v1:app-version:ios:YmV0YQ",
        ]),
    selectionContextHash: chance(0.1) ? null : oneOf(["v1:0", "v1:0", "v1:1"]),
  };
};
const authorizeCases = Array.from({ length: 300 }, () => {
  const active = chance(0.08) ? null : receipt();
  // Half of the desired receipts share the active scope, so every reason shows.
  const desired =
    active !== null && chance(0.5)
      ? {
          ...receipt(),
          catalogId: active.catalogId,
          scopeKey: active.scopeKey,
          generation: chance(0.5) ? active.generation : receipt().generation,
          selectionContextHash: chance(0.5)
            ? active.selectionContextHash
            : receipt().selectionContextHash,
        }
      : receipt();
  const explicitScopeSwitch = chance(0.4);
  return {
    active,
    desired,
    explicitScopeSwitch,
    result: authorizeReleaseTransition({
      active,
      desired,
      explicitScopeSwitch,
    }),
  };
});

/** One case per line: small enough to commit, and diffs show which cases moved. */
const serializeFixture = (fixture: Record<string, unknown>): string => {
  const block = (value: unknown, indent: string): string => {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      return `[\n${value
        .map((item) => `${indent} ${JSON.stringify(item)}`)
        .join(",\n")}\n${indent}]`;
    }
    if (value !== null && typeof value === "object") {
      return `{\n${Object.entries(value)
        .map(
          ([key, entry]) =>
            `${indent} ${JSON.stringify(key)}: ${block(entry, `${indent} `)}`,
        )
        .join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return `${block(fixture, "")}\n`;
};

describe("release selection conformance fixture", () => {
  it("matches the protocol implementation", async () => {
    const fixture = {
      // Native tests build a body over this limit themselves.
      maxReleaseCatalogWireBytes: MAX_RELEASE_CATALOG_WIRE_BYTES,
      appVersion: appVersionCases,
      channelKey: channelKeyCases,
      scopeKey: { create: scopeCreateCases, parse: scopeParseCases },
      cohort: { normalize: normalizeCohortCases, eligible: eligibilityCases },
      selectionContextHash: hashInputs,
      parseReleaseCatalog: parseCatalogCases,
      selectDesiredRelease: selectionCases,
      authorizeReleaseTransition: authorizeCases,
    };
    await expect(serializeFixture(fixture)).toMatchFileSnapshot(FIXTURE_PATH);
  });
});
