// Generate native policy parity cases from the actual shared JS selector.
import fs from "node:fs/promises";

import {
  authorizeReleaseTransition,
  createReleaseSelectionContextHash,
  getRolledOutNumericCohorts,
  selectDesiredRelease,
} from "../packages/core/dist/index.mjs";

const id = (n) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const embedded = id(1);
const scopeKey = "v1:app-version:ios:cHJvZHVjdGlvbg";
const receipt = (bundle, release, generation = 1) => ({
  kind: "BUNDLE",
  releaseId: id(release),
  bundleId: id(bundle),
  catalogId: "lynx-policy-fixture",
  scopeKey,
  generation,
  catalogHash: `sha256:${"a".repeat(64)}`,
  channel: "production",
  selectionContextHash: "v1:0000000000000000",
});
const builtin = {
  kind: "BUILTIN",
  releaseId: null,
  bundleId: embedded,
  catalogId: null,
  scopeKey: null,
  generation: null,
  catalogHash: null,
  channel: "production",
  selectionContextHash: null,
};
const descriptor = (bundle, release, extra = {}) => ({
  releaseId: id(release),
  kind: bundle === null ? "EMBEDDED" : "BUNDLE",
  bundleId: bundle === null ? null : id(bundle),
  rolloutCohortCount: 1000,
  targetCohorts: [],
  shouldForceUpdate: false,
  message: null,
  ...extra,
});
const cases = [
  { name: "first-update", releases: [descriptor(20, 120)] },
  { name: "empty-keeps-embedded", releases: [] },
  {
    name: "confirmed-current-retained",
    running: receipt(20, 120),
    releases: [descriptor(20, 120)],
  },
  {
    name: "next-selection-is-policy-base",
    running: receipt(20, 120),
    next: receipt(30, 130),
    releases: [descriptor(30, 130), descriptor(20, 120)],
  },
  {
    name: "two-unknown-exits-do-not-reenable-b",
    running: receipt(10, 110),
    exclusions: [id(130), id(120)],
    releases: [descriptor(30, 130), descriptor(20, 120), descriptor(10, 110)],
  },
  {
    name: "fresh-release-retries-unknown-cached-bytes",
    running: receipt(10, 110),
    exclusions: [id(130), id(120)],
    releases: [
      descriptor(20, 140),
      descriptor(30, 130),
      descriptor(20, 120),
      descriptor(10, 110),
    ],
  },
  {
    name: "fresh-release-cannot-bypass-fatal-bundle",
    running: receipt(10, 110),
    crashed: [id(20)],
    releases: [descriptor(20, 140), descriptor(10, 110)],
  },
  {
    name: "rollback-skips-excluded-predecessor",
    running: receipt(40, 140),
    exclusions: [id(130)],
    releases: [],
    rollback: [descriptor(30, 130), descriptor(20, 120)],
  },
  {
    name: "rollback-predecessor-does-not-require-rollout-cohort",
    running: receipt(30, 130),
    releases: [],
    rollback: [
      descriptor(30, 130, { rolloutCohortCount: 0 }),
      descriptor(20, 120, { rolloutCohortCount: 0 }),
    ],
  },
  {
    name: "rollback-cohort-exception-cannot-bypass-release-exclusion",
    running: receipt(30, 130),
    exclusions: [id(120)],
    releases: [],
    rollback: [
      descriptor(30, 130, { rolloutCohortCount: 0 }),
      descriptor(20, 120, { rolloutCohortCount: 0 }),
    ],
  },
  {
    name: "embedded-release-held-after-unknown-exit",
    running: receipt(10, 110),
    exclusions: [id(140)],
    releases: [descriptor(null, 140), descriptor(10, 110)],
  },
  {
    name: "explicit-embedded-rollback",
    running: receipt(10, 110),
    releases: [descriptor(null, 140)],
  },
  {
    name: "ineligible-current-falls-back-to-builtin",
    running: receipt(20, 120),
    releases: [descriptor(20, 120, { rolloutCohortCount: 0 })],
  },
  {
    name: "native-minimum-excludes-old-bytes",
    minimum: id(25),
    releases: [descriptor(20, 120)],
  },
  {
    name: "custom-cohort-target",
    cohort: "beta",
    releases: [
      descriptor(20, 120, { rolloutCohortCount: 0, targetCohorts: ["beta"] }),
    ],
  },
  {
    name: "context-keeps-all-exclusions-canonically",
    exclusions: [
      ...Array.from({ length: 12 }, (_, n) => id(200 + n)).reverse(),
      id(205),
    ],
    releases: [descriptor(20, 120)],
  },
  {
    name: "same-generation-same-context-denied",
    running: receipt(20, 120, 2),
    contextMatches: true,
    releases: [descriptor(30, 130), descriptor(20, 120)],
  },
  {
    name: "older-policy-generation-denied",
    running: receipt(20, 120, 3),
    releases: [descriptor(30, 130), descriptor(20, 120)],
  },
];

const included = getRolledOutNumericCohorts(id(120), 137);
const excluded = Array.from({ length: 1000 }, (_, n) => n + 1).filter(
  (cohort) => !included.includes(cohort),
);
for (const [eligibility, cohorts] of [
  ["included", included],
  ["excluded", excluded],
]) {
  for (const cohort of [
    cohorts[0],
    cohorts[Math.floor(cohorts.length / 2)],
    cohorts.at(-1),
  ]) {
    cases.push({
      name: `partial-rollout-${eligibility}-${cohort}`,
      cohort: String(cohort),
      releases: [descriptor(20, 120, { rolloutCohortCount: 137 })],
    });
  }
}

const vectors = [];
for (const platform of ["ios", "android"])
  for (const item of cases) {
    const adapt = (value) =>
      value?.scopeKey
        ? { ...value, scopeKey: scopeKey.replace(":ios:", `:${platform}:`) }
        : value;
    const snapshot = {
      revision: "policy-fixture-revision",
      platform,
      appVersion: "1.0.0",
      channel: "production",
      runtimeId: "policy-fixture-runtime",
      embeddedBundleId: embedded,
      minimumBundleId: item.minimum ?? embedded,
      cohort: item.cohort ?? "1",
      runningSelection: adapt(item.running ?? builtin),
      runningConfirmed: true,
      confirmedSelection: adapt(item.running ?? builtin),
      nextSelection: adapt(item.next ?? null),
      crashedBundleIds: item.crashed ?? [],
      unconfirmedReleaseIds: item.exclusions ?? [],
    };
    const base = snapshot.nextSelection ?? snapshot.runningSelection;
    const catalog = {
      schemaVersion: 1,
      catalogId: "lynx-policy-fixture",
      scopeKey: scopeKey.replace(":ios:", `:${platform}:`),
      generation: 2,
      catalogHash: `sha256:${"a".repeat(64)}`,
      fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
      releases: item.releases,
      ...(item.rollback ? { rollbackReleases: item.rollback } : {}),
    };
    const contextHash = createReleaseSelectionContextHash({
      activeBundleId: base.bundleId,
      activeReleaseId: base.releaseId,
      cohort: snapshot.cohort,
      minimumReleaseId: snapshot.minimumBundleId,
      strategy: "APP_VERSION",
      strategyValue: snapshot.appVersion,
      crashedBundleIds: snapshot.crashedBundleIds,
      unconfirmedReleaseIds: snapshot.unconfirmedReleaseIds,
    });
    if (item.contextMatches) base.selectionContextHash = contextHash;
    const desired = selectDesiredRelease(catalog, {
      builtInBundleId: embedded,
      currentBundleId: base.bundleId,
      activeReleaseId: base.releaseId,
      minimumReleaseId: snapshot.minimumBundleId,
      cohort: snapshot.cohort,
      crashedBundleIds: snapshot.crashedBundleIds,
      unconfirmedReleaseIds: snapshot.unconfirmedReleaseIds,
    });
    const selection = desired
      ? {
          kind: desired.kind,
          releaseId: desired.releaseId,
          bundleId: desired.bundleId,
          catalogId: catalog.catalogId,
          scopeKey: catalog.scopeKey,
          generation: catalog.generation,
          catalogHash: catalog.catalogHash,
          channel: snapshot.channel,
          selectionContextHash: contextHash,
        }
      : null;
    vectors.push({
      name: `${platform}/${item.name}`,
      snapshot,
      catalog,
      expected: {
        contextHash,
        selection,
        status: desired?.status ?? null,
        authorization: selection
          ? authorizeReleaseTransition({
              active: base,
              desired: selection,
              explicitScopeSwitch: false,
            })
          : null,
      },
    });
  }
const destination = new URL(
  "../packages/lynx/fixtures/catalog-policy.json",
  import.meta.url,
);
await fs.mkdir(new URL(".", destination), { recursive: true });
await fs.writeFile(destination, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`Generated ${vectors.length} native policy scenarios.`);
