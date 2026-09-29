import { normalizeRange, rangesIntersect } from "verkit";
import { describe, expect, it } from "vitest";

import {
  MINOR_LINE_CAP,
  minorLinesOf,
  releaseBaseCandidateKeys,
  targetBaseCandidateKey,
} from "./baseCandidates";

const release = (
  targetAppVersion: string,
  overrides: Partial<Parameters<typeof releaseBaseCandidateKeys>[0]> = {},
) => ({
  kind: "BUNDLE" as const,
  bundle_id: "bundle-1",
  enabled: true,
  channel_id: "channel-1",
  platform: "ios" as const,
  strategy: "APP_VERSION" as const,
  fingerprint_hash: null,
  target_app_version: targetAppVersion,
  ...overrides,
});

const target = (appVersion: string) => ({
  channelId: "channel-1",
  platform: "ios",
  fingerprintHash: null,
  appVersion,
});

const linesFrom = (major: number, first: number, count: number) =>
  Array.from({ length: count }, (_, n) => `${major}.${first + n}`);

/** New rule: the release holds the target's single minor line. */
const sharesLine = (releaseRange: string, targetRange: string) => {
  const key = targetBaseCandidateKey(target(targetRange));
  return (
    key !== null &&
    releaseBaseCandidateKeys(release(releaseRange)).includes(key)
  );
};

/** Today's rule in `deploy.ts`: the two ranges intersect. */
const intersects = (releaseRange: string, targetRange: string) => {
  const left = normalizeRange(targetRange);
  const right = normalizeRange(releaseRange);
  return left !== null && right !== null && rangesIntersect(left, right);
};

describe("minor lines", () => {
  it.each([
    ["1.2.3", ["1.2"], false],
    ["1.2.3-beta.1", ["1.2"], false],
    ["1.2.x", ["1.2"], false],
    ["1.2", ["1.2"], false],
    ["~1.2.3", ["1.2"], false],
    ["^0.2.3", ["0.2"], false],
    [">=1.0.0 <1.4.0", ["1.0", "1.1", "1.2", "1.3"], false],
    ["1.2.3 - 1.4.0", ["1.2", "1.3", "1.4"], false],
    ["1.5.x || 1.2.x", ["1.2", "1.5"], false],
    ["1.0.0 || 2.0.0", ["1.0", "2.0"], false],
    [">=1.0.0 <1.16.0", linesFrom(1, 0, 16), false],
    [">=1.0.0 <1.17.0", linesFrom(1, 0, 16), true],
    ["1.x", linesFrom(1, 0, 16), true],
    ["^1.2.3", linesFrom(1, 2, 16), true],
    [">=1.5.0 <2.1.0", linesFrom(1, 5, 16), true],
    ["*", linesFrom(0, 0, 16), true],
  ])("%s covers %j (truncated: %s)", (range, lines, truncated) => {
    expect(minorLinesOf(range)).toEqual({ lines, truncated });
  });

  it("rejects invalid ranges", () => {
    expect(minorLinesOf("not a range")).toBeNull();
    expect(releaseBaseCandidateKeys(release("not a range"))).toEqual([]);
    expect(targetBaseCandidateKey(target("not a range"))).toBeNull();
  });
});

describe("base candidate keys", () => {
  it("keys an enabled bundle release by fingerprint, or by each minor line up to the cap", () => {
    expect(releaseBaseCandidateKeys(release("1.2.x"))).toEqual([
      JSON.stringify(["channel-1", "ios", "app-version", "1.2"]),
    ]);
    expect(releaseBaseCandidateKeys(release("1.x"))).toHaveLength(
      MINOR_LINE_CAP,
    );
    expect(
      releaseBaseCandidateKeys(
        release("1.0.0", {
          strategy: "FINGERPRINT",
          fingerprint_hash: "fp",
          target_app_version: null,
        }),
      ),
    ).toEqual([JSON.stringify(["channel-1", "ios", "fingerprint", "fp"])]);
    for (const overrides of [
      { enabled: false },
      { kind: "EMBEDDED" as const, bundle_id: null },
      { target_app_version: null },
    ]) {
      expect(releaseBaseCandidateKeys(release("1.2.x", overrides))).toEqual([]);
    }
  });

  it("keeps keys ASCII for any channel id", () => {
    const key = targetBaseCandidateKey({
      ...target("1.2.3"),
      channelId: "채널-🚀",
    })!;
    expect(key).toMatch(/^[\x20-\x7e]+$/u);
    expect(JSON.parse(key)).toEqual(["채널-🚀", "ios", "app-version", "1.2"]);
  });

  it("gives a new bundle a key only when its target spans one minor line", () => {
    expect(targetBaseCandidateKey(target("1.2.3"))).toBe(
      JSON.stringify(["channel-1", "ios", "app-version", "1.2"]),
    );
    expect(targetBaseCandidateKey(target("~1.2.3"))).not.toBeNull();
    expect(targetBaseCandidateKey(target("1.x"))).toBeNull();
    expect(targetBaseCandidateKey(target(">=1.2.0 <1.4.0"))).toBeNull();
    expect(
      targetBaseCandidateKey({ ...target("1.x"), fingerprintHash: "fp" }),
    ).toBe(JSON.stringify(["channel-1", "ios", "fingerprint", "fp"]));
  });
});

/**
 * PRD follow-up "minor-line cap (default 16), checked in C1 against today's
 * compatibility rule": today `deploy.ts` pairs ranges that intersect.
 */
describe("the minor-line rule against today's rule", () => {
  const releases = [
    "1.0.0",
    "1.2.3",
    "1.2.9",
    "1.3.0",
    "2.0.0",
    "0.2.5",
    "1.2.3-beta.1",
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
  ];
  const targets = [
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
    "0.2.5",
    "1.2.x",
    "~1.2.3",
    "1.x",
    "*",
  ];
  const pairs = releases.flatMap((releaseRange) =>
    targets.map((targetRange) => ({
      releaseRange,
      targetRange,
      today: intersects(releaseRange, targetRange),
      next: sharesLine(releaseRange, targetRange),
    })),
  );

  it("keeps every match today's rule makes for a one-line target and a release within the cap", () => {
    const kept = pairs.filter(
      ({ releaseRange, targetRange, today }) =>
        today &&
        minorLinesOf(targetRange, 1)?.truncated === false &&
        minorLinesOf(releaseRange)?.truncated === false,
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.filter(({ next }) => !next)).toEqual([]);
  });

  const oneLine = (range: string) =>
    minorLinesOf(range, 1)?.truncated === false;

  it("adds only matches where the ranges share a minor line but no version", () => {
    const added = pairs.filter(({ today, next }) => next && !today);
    expect(added).toHaveLength(19);
    expect(added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          releaseRange: "1.2.3",
          targetRange: "1.2.4",
        }),
        expect.objectContaining({
          releaseRange: "~1.2.5",
          targetRange: "1.2.3",
        }),
      ]),
    );
  });

  it("loses matches only for targets spanning several lines and for lines past a wide release's cap", () => {
    const lost = pairs.filter(({ today, next }) => today && !next);
    const pastCap = lost.filter(({ targetRange }) => oneLine(targetRange));
    for (const { releaseRange } of pastCap) {
      expect(minorLinesOf(releaseRange)?.truncated).toBe(true);
    }
    expect(pastCap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ releaseRange: "1.x", targetRange: "1.16.0" }),
        // `*` keeps 0.0 to 0.15, so it no longer serves 1.x targets
        expect.objectContaining({ releaseRange: "*", targetRange: "1.0.0" }),
      ]),
    );
    expect({
      pairs: pairs.length,
      today: pairs.filter(({ today }) => today).length,
      agree: pairs.filter(({ today, next }) => today === next).length,
      added: pairs.filter(({ today, next }) => next && !today).length,
      lostSeveralLineTargets: lost.length - pastCap.length,
      lostPastCap: pastCap.length,
    }).toEqual({
      pairs: 368,
      today: 165,
      agree: 279,
      added: 19,
      lostSeveralLineTargets: 40,
      lostPastCap: 30,
    });
  });
});
