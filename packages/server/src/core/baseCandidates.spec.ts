import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import type { Bundle } from "@hot-updater/protocol";
import { normalizeRange, rangesIntersect } from "verkit";
import { describe, expect, it } from "vitest";

import { createBundleFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createInProcessCoreApi } from "./api";
import {
  parseBaseCandidateKey,
  targetBaseCandidateKey,
  type BaseCandidateTarget,
} from "./baseCandidates";

type Target = Pick<BaseCandidateTarget, "appVersion" | "fingerprintHash">;

/**
 * The rule `deploy.ts` used before base candidates came from the catalog
 * (`getPatchBaseBundles` on `next`): page the channel and platform's enabled
 * releases newest first, keep bundle releases older than the new bundle with
 * the same fingerprint or an intersecting range, each bundle once.
 */
const referenceBaseBundleIds = async (
  core: HotUpdaterCoreApi,
  channel: string,
  target: Target,
  bundleId: string,
  maxBaseBundles: number,
): Promise<string[]> => {
  const channelRow = await core.findChannelByName(channel);
  if (channelRow === null) return [];
  const pageSize = Math.max(maxBaseBundles * 3, 10);
  const found: string[] = [];
  let after: string | undefined;
  while (found.length < maxBaseBundles) {
    const releases = await core.listReleases({
      filter: {
        kind: "channelPlatform",
        channelId: channelRow.id,
        platform: "ios",
        enabled: true,
      },
      order: "desc",
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
    });
    for (const release of releases) {
      const left = target.appVersion && normalizeRange(target.appVersion);
      const right =
        release.target_app_version &&
        normalizeRange(release.target_app_version);
      const compatible = target.fingerprintHash
        ? release.strategy === "FINGERPRINT" &&
          release.fingerprint_hash === target.fingerprintHash
        : release.strategy === "APP_VERSION" &&
          !!left &&
          !!right &&
          rangesIntersect(left, right);
      const id = release.bundle_id;
      if (
        compatible &&
        release.kind === "BUNDLE" &&
        id !== null &&
        id < bundleId &&
        !found.includes(id) &&
        found.length < maxBaseBundles
      ) {
        found.push(id);
      }
    }
    if (releases.length < pageSize) break;
    after = releases.at(-1)!.id;
  }
  return found;
};

const baseBundleIds = (
  core: HotUpdaterCoreApi,
  channel: string,
  target: Target,
  bundleId: string,
  maxBaseBundles: number,
): Promise<string[]> => {
  const key = targetBaseCandidateKey({ channel, platform: "ios", ...target });
  return key === null
    ? Promise.resolve([])
    : core.findBaseBundleIds(key, bundleId, maxBaseBundles);
};

const bundleOf = (n: number): Bundle => ({
  ...createBundleFixture(String(n)),
  patches: [],
});
const idOf = (n: number) => createBundleFixture(String(n)).id;
const NEWEST = idOf(999);

const policy = (overrides: {
  readonly channel?: string;
  readonly targetAppVersion?: string | null;
  readonly fingerprintHash?: string | null;
}) => ({
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: null,
  ...overrides,
});

const RELEASE_RANGES = [
  "1.0.0",
  "1.2.3",
  "1.2.9",
  "1.3.0",
  "2.0.0",
  "0.2.5",
  "1.2.3-beta.1",
  "1.2",
  "1.2.x",
  "2.x",
  "~1.2.3",
  "~1.2.5",
  "^0.2.3",
  ">=1.0.0 <1.4.0",
  ">=1.2.0 <=1.2.5",
  "1.2.3 - 1.4.0",
  ">=1.0.0 <1.16.0",
  "1.2.x || 1.5.x",
  "1.0.0 || 2.0.0",
  "1.x",
  "^1.2.3",
  ">=1.2.0",
  "<2.0.0",
  "*",
  "1.20.0",
  "1.20.x",
  ">=1.5.0 <2.1.0",
  "3.0.0",
];

const TARGET_RANGES = [
  "1.0.0",
  "1.2.0",
  "1.2.3",
  "1.2.4",
  "1.2.9",
  "1.3.0",
  "1.5.2",
  "1.15.2",
  "1.16.0",
  "1.20.0",
  "2.0.0",
  "3.0.0",
  "0.2.5",
  "1.2",
  "1.2.x",
  "~1.2.3",
  "^1.2.3",
  "1.x",
  "2.x",
  "0.x",
  ">=1.2.0 <2",
  ">=1.0.0",
  "1.2.3 || 2.0.0",
  "*",
];

describe("base candidate keys", () => {
  it("names the target's catalog scope and normalized range", () => {
    const key = targetBaseCandidateKey({
      channel: "채널-🚀",
      platform: "ios",
      fingerprintHash: null,
      appVersion: "1.2.x",
    })!;
    expect(key).toMatch(/^[\x20-\x7e]+$/u);
    expect(parseBaseCandidateKey(key)).toEqual({
      scopeKey: expect.stringMatching(/^v1:app-version:ios:/),
      range: ">=1.2.0 <1.3.0-0",
    });
    expect(
      parseBaseCandidateKey(
        targetBaseCandidateKey({
          channel: "production",
          platform: "android",
          fingerprintHash: "fp",
          appVersion: "1.x",
        })!,
      ),
    ).toEqual({
      scopeKey: expect.stringMatching(/^v1:fingerprint:android:.*:fp$/),
      range: null,
    });
  });

  it("names nothing for an invalid range or key", () => {
    expect(
      targetBaseCandidateKey({
        channel: "production",
        platform: "ios",
        fingerprintHash: null,
        appVersion: "not a range",
      }),
    ).toBeNull();
    for (const key of [
      "",
      "[]",
      '["v1:app-version:ios"]',
      '["x", "*"]',
      '["v1:app-version:ios:cHJvZHVjdGlvbg", "not a range"]',
    ]) {
      expect(parseBaseCandidateKey(key)).toBeNull();
    }
  });
});

describe("auto-patch bases against the rule deploy used before", () => {
  it("finds exactly the bases the reference finds, for every range pair", async () => {
    const core = createInProcessCoreApi(createMemoryAdapter());
    for (const [n, range] of RELEASE_RANGES.entries()) {
      await core.deploy([
        {
          bundle: bundleOf(100 + n),
          release: policy({ targetAppVersion: range }),
        },
      ]);
    }
    const differences: string[] = [];
    const withoutBases: string[] = [];
    let matches = 0;
    for (const range of TARGET_RANGES) {
      const target = { appVersion: range, fingerprintHash: null };
      const reference = await referenceBaseBundleIds(
        core,
        "production",
        target,
        NEWEST,
        100,
      );
      matches += reference.length;
      if (reference.length === 0) withoutBases.push(range);
      const found = await baseBundleIds(
        core,
        "production",
        target,
        NEWEST,
        100,
      );
      if (JSON.stringify(found) !== JSON.stringify(reference)) {
        differences.push(range);
      }
      // `maxBaseBundles` keeps the newest releases first, as before
      await expect(
        baseBundleIds(core, "production", target, NEWEST, 3),
      ).resolves.toEqual(reference.slice(0, 3));
    }
    expect(differences).toEqual([]);
    // 299 of the 672 pairs meet, and every target, `*` and `1.x` included,
    // finds bases
    expect(matches).toBe(299);
    expect(withoutBases).toEqual([]);
  });

  it("pairs no target in the gap of a lone release's range", async () => {
    const core = createInProcessCoreApi(createMemoryAdapter());
    await core.deploy([
      {
        bundle: bundleOf(100),
        release: policy({ targetAppVersion: "1.2.x || 1.5.x" }),
      },
    ]);
    for (const [appVersion, bases] of [
      ["1.4.0", []],
      ["1.2.4", [idOf(100)]],
      ["1.5.2", [idOf(100)]],
    ] as const) {
      const target = { appVersion, fingerprintHash: null };
      await expect(
        referenceBaseBundleIds(core, "production", target, NEWEST, 3),
      ).resolves.toEqual(bases);
      await expect(
        baseBundleIds(core, "production", target, NEWEST, 3),
      ).resolves.toEqual(bases);
    }
  });

  it("differs only for an exact prerelease target that a release names", async () => {
    // Both rules pair `1.2.3-beta.1` only with ranges that allow its
    // prerelease; the catalog keeps no range text, so once a release names
    // that prerelease, the other ranges around it pair with it too. No
    // device runs a prerelease app version: the update check coerces it.
    const core = createInProcessCoreApi(createMemoryAdapter());
    for (const [n, range] of ["1.2.x", "1.2.3-beta.1"].entries()) {
      await core.deploy([
        {
          bundle: bundleOf(100 + n),
          release: policy({ targetAppVersion: range }),
        },
      ]);
    }
    const target = { appVersion: "1.2.3-beta.1", fingerprintHash: null };
    await expect(
      referenceBaseBundleIds(core, "production", target, NEWEST, 3),
    ).resolves.toEqual([idOf(101)]);
    await expect(
      baseBundleIds(core, "production", target, NEWEST, 3),
    ).resolves.toEqual([idOf(101), idOf(100)]);
    const ranged = { appVersion: "1.2.x", fingerprintHash: null };
    await expect(
      baseBundleIds(core, "production", ranged, NEWEST, 3),
    ).resolves.toEqual(
      await referenceBaseBundleIds(core, "production", ranged, NEWEST, 3),
    );
  });

  it("orders by release like the reference: promotions, republishes, disabled releases, fingerprints", async () => {
    const core = createInProcessCoreApi(createMemoryAdapter());
    const both = async (target: Target) => {
      const reference = await referenceBaseBundleIds(
        core,
        "production",
        target,
        NEWEST,
        3,
      );
      await expect(
        baseBundleIds(core, "production", target, NEWEST, 3),
      ).resolves.toEqual(reference);
      return reference;
    };
    const v1 = { appVersion: "1.0.0", fingerprintHash: null };
    const [staged] = await core.deploy([
      {
        bundle: bundleOf(10),
        release: policy({ channel: "staging", targetAppVersion: "1.0.0" }),
      },
    ]);
    const releaseIds: string[] = [];
    for (let n = 11; n <= 15; n += 1) {
      const [deployed] = await core.deploy([
        { bundle: bundleOf(n), release: policy({ targetAppVersion: "1.0.0" }) },
      ]);
      releaseIds.push(deployed!.release!.id);
    }
    expect(await both(v1)).toEqual([15, 14, 13].map(idOf));
    // a promotion is the newest release of an older bundle
    await core.promoteRelease({
      releaseId: staged!.release!.id,
      targetChannel: "production",
    });
    expect(await both(v1)).toEqual([10, 15, 14].map(idOf));
    await core.deploy([
      { bundleId: idOf(11), release: policy({ targetAppVersion: "1.0.0" }) },
    ]);
    expect(await both(v1)).toEqual([11, 10, 15].map(idOf));
    await core.updateReleasePolicy({
      releaseId: releaseIds[4]!,
      patch: { enabled: false },
    });
    expect(await both(v1)).toEqual([11, 10, 14].map(idOf));
    for (let n = 20; n <= 23; n += 1) {
      await core.deploy([
        {
          bundle: bundleOf(n),
          release: policy({ fingerprintHash: n === 22 ? "fp-b" : "fp-a" }),
        },
      ]);
    }
    expect(await both({ appVersion: null, fingerprintHash: "fp-a" })).toEqual(
      [23, 21, 20].map(idOf),
    );
    // the new bundle is never its own base, nor is a newer one
    await expect(
      baseBundleIds(core, "production", v1, idOf(14), 3),
    ).resolves.toEqual([11, 10, 13].map(idOf));
  });
});
