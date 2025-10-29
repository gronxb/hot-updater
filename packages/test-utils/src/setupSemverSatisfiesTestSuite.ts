import { expect, it } from "vitest";

/**
 *
 * Filters based on semver. And sorts by the highest bundle version.
 *
 * * Range Expression Table:
 *
 * | Range Expression | Who gets the update                                                    |
 * |------------------|------------------------------------------------------------------------|
 * | 1.2.3            | Only devices running the specific binary app store version 1.2.3 of your app |
 * | *                | Any device configured to consume updates from your CodePush app         |
 * | 1.2.x            | Devices running major version 1, minor version 2 and any patch version of your app |
 * | 1.2.3 - 1.2.7    | Devices running any binary version between 1.2.3 (inclusive) and 1.2.7 (inclusive) |
 * | >=1.2.3 <1.2.7   | Devices running any binary version between 1.2.3 (inclusive) and 1.2.7 (exclusive) |
 * | 1.2              | Equivalent to >=1.2.0 <1.3.0                                            |
 * | ~1.2.3           | Equivalent to >=1.2.3 <1.3.0                                            |
 * | ^1.2.3           | Equivalent to >=1.2.3 <2.0.0                                            |
 */
export const setupSemverSatisfiesTestSuite = ({
  semverSatisfies,
}: {
  semverSatisfies: (
    targetAppVersion: string,
    currentVersion: string,
  ) => Promise<boolean> | boolean;
}) => {
  it("version 1.2.3 should satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("1.2.3", "1.2.3")).toBe(true);
  });

  it("version 1.2.4 should not satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("1.2.3", "1.2.4")).toBe(false);
  });

  it("version 1.2.4 should not satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("1.2.3", "1.2.4")).toBe(false);
  });

  it("version 1.2.4 should not satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("1.2.3", "1.2.4")).toBe(false);
  });

  it("1.x.x should satisfy version 1.0", async () => {
    expect(await semverSatisfies("1.x.x", "1.0")).toBe(true);
  });

  it("1.x.x should satisfy version 1.12", async () => {
    expect(await semverSatisfies("1.x.x", "1.12")).toBe(true);
  });

  it("1.x.x should satisfy version 1.0.0", async () => {
    expect(await semverSatisfies("1.x.x", "1.0.0")).toBe(true);
  });

  it("1.x.x should satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("1.x.x", "1.2.3")).toBe(true);
  });

  it("1.x.x should not satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("1.x.x", "2.0.0")).toBe(false);
  });

  it("1.x.x should not satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("1.x.x", "2.0.0")).toBe(false);
  });

  it("1.2.x should satisfy version 1.2.5", async () => {
    expect(await semverSatisfies("1.2.x", "1.2.5")).toBe(true);
  });

  it("1.2.x should not satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("1.2.x", "1.3.0")).toBe(false);
  });

  it("1.2.x should not satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("1.2.x", "1.3.0")).toBe(false);
  });

  it("range 1.2.3-1.2.7 should satisfy version 1.2.5", async () => {
    expect(await semverSatisfies("1.2.3 - 1.2.7", "1.2.5")).toBe(true);
  });

  it("range 1.2.3-1.2.7 should satisfy version 1.2.5", async () => {
    expect(await semverSatisfies("1.2.3 - 1.2.7", "1.2.5")).toBe(true);
  });

  it("range 1.2.3-1.2.7 should not satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("1.2.3 - 1.2.7", "1.3.0")).toBe(false);
  });

  it("range >=1.2.3 <1.2.7 should satisfy version 1.2.5", async () => {
    expect(await semverSatisfies(">=1.2.3 <1.2.7", "1.2.5")).toBe(true);
  });

  it("range >=1.2.3 <1.2.7 should satisfy version 1.2.5", async () => {
    expect(await semverSatisfies(">=1.2.3 <1.2.7", "1.2.5")).toBe(true);
  });

  it("range >=1.2.3 <1.2.7 should not satisfy version 1.2.7", async () => {
    expect(await semverSatisfies(">=1.2.3 <1.2.7", "1.2.7")).toBe(false);
  });

  it("~1.2.3 should satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("~1.2.3", "1.2.3")).toBe(true);
  });

  it("~1.2.3 should satisfy version 1.2.4", async () => {
    expect(await semverSatisfies("~1.2.3", "1.2.4")).toBe(true);
  });

  it("~1.2.3 should not satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("~1.2.3", "1.3.0")).toBe(false);
  });

  it("~1.2.3 should satisfy version 1.2.3", async () => {
    expect(await semverSatisfies("~1.2.3", "1.2.3")).toBe(true);
  });

  it("~1.2.3 should satisfy version 1.2.4", async () => {
    expect(await semverSatisfies("~1.2.3", "1.2.4")).toBe(true);
  });

  it("~1.2.3 should not satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("~1.2.3", "1.3.0")).toBe(false);
  });

  it("^1.2.3 should satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("^1.2.3", "1.3.0")).toBe(true);
  });

  it("^1.2.3 should satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("^1.2.3", "1.3.0")).toBe(true);
  });

  it("^1.2.3 should not satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("^1.2.3", "2.0.0")).toBe(false);
  });

  it("version 1.2 should satisfy version 1.2.0 (equivalent to >=1.2.0 <1.3.0)", async () => {
    expect(await semverSatisfies("1.2", "1.2.0")).toBe(true);
  });

  it("version 1.2 should satisfy version 1.2.99 (equivalent to >=1.2.0 <1.3.0)", async () => {
    expect(await semverSatisfies("1.2", "1.2.99")).toBe(true);
  });

  it("version 1.2 should not satisfy version 1.3.0", async () => {
    expect(await semverSatisfies("1.2", "1.3.0")).toBe(false);
  });

  it("single-major '1' should satisfy version 1.0.0 (equivalent to >=1.0.0 <2.0.0)", async () => {
    expect(await semverSatisfies("1", "1.0.0")).toBe(true);
  });

  it("single-major '1' should satisfy version 1.99.99", async () => {
    expect(await semverSatisfies("1", "1.99.99")).toBe(true);
  });

  it("single-major '1' should not satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("1", "2.0.0")).toBe(false);
  });

  it("0.x.x should satisfy version 0.5.10", async () => {
    expect(await semverSatisfies("0.x.x", "0.5.10")).toBe(true);
  });

  it("0.x.x should not satisfy version 1.0.0", async () => {
    expect(await semverSatisfies("0.x.x", "1.0.0")).toBe(false);
  });

  it("2.x should satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("2.x", "2.0.0")).toBe(true);
  });

  it("2.x should satisfy version 2.10.1", async () => {
    expect(await semverSatisfies("2.x", "2.10.1")).toBe(true);
  });

  it("2.x should not satisfy version 3.0.0", async () => {
    expect(await semverSatisfies("2.x", "3.0.0")).toBe(false);
  });

  it("simple star * should satisfy any version, e.g. 10.11.12", async () => {
    expect(await semverSatisfies("*", "10.11.12")).toBe(true);
  });

  it("simple star * should satisfy any version, e.g. 0.0.1", async () => {
    expect(await semverSatisfies("*", "0.0.1")).toBe(true);
  });

  it("2.x.x should satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("2.x.x", "2.0.0")).toBe(true);
  });

  it("2.x.x should satisfy version 2.9.9", async () => {
    expect(await semverSatisfies("2.x.x", "2.9.9")).toBe(true);
  });

  it("2.x.x should not satisfy version 3.0.0", async () => {
    expect(await semverSatisfies("2.x.x", "3.0.0")).toBe(false);
  });

  it("0.x.x should satisfy version 0.1.0", async () => {
    expect(await semverSatisfies("0.x.x", "0.1.0")).toBe(true);
  });

  it("0.x.x should satisfy version 0.9.9", async () => {
    expect(await semverSatisfies("0.x.x", "0.9.9")).toBe(true);
  });

  it("0.x.x should not satisfy version 1.0.0", async () => {
    expect(await semverSatisfies("0.x.x", "1.0.0")).toBe(false);
  });

  it("range 1.2.3 - 2.0.0 should satisfy version 1.2.4", async () => {
    expect(await semverSatisfies("1.2.3 - 2.0.0", "1.2.4")).toBe(true);
  });

  it("range 1.2.3 - 2.0.0 should satisfy version 2.0.0", async () => {
    expect(await semverSatisfies("1.2.3 - 2.0.0", "2.0.0")).toBe(true);
  });

  it("range 1.2.3 - 2.0.0 should satisfy version 1.5.0", async () => {
    expect(await semverSatisfies("1.2.3 - 2.0.0", "1.5.0")).toBe(true);
  });

  it("range 1.2.3 - 2.0.0 should not satisfy version 2.0.1", async () => {
    expect(await semverSatisfies("1.2.3 - 2.0.0", "2.0.1")).toBe(false);
  });

  // Bounded range tests with >= and <= operators (Issue #632)
  it("range >= 5.7.0 <= 5.7.4 should satisfy version 5.7.3", async () => {
    expect(await semverSatisfies(">= 5.7.0 <= 5.7.4", "5.7.3")).toBe(true);
  });

  it("range >= 5.7.0 <= 5.7.4 should satisfy version 5.7.0", async () => {
    expect(await semverSatisfies(">= 5.7.0 <= 5.7.4", "5.7.0")).toBe(true);
  });

  it("range >= 5.7.0 <= 5.7.4 should satisfy version 5.7.4", async () => {
    expect(await semverSatisfies(">= 5.7.0 <= 5.7.4", "5.7.4")).toBe(true);
  });

  it("range >= 5.7.0 <= 5.7.4 should not satisfy version 5.6.9", async () => {
    expect(await semverSatisfies(">= 5.7.0 <= 5.7.4", "5.6.9")).toBe(false);
  });

  it("range >= 5.7.0 <= 5.7.4 should not satisfy version 5.7.5", async () => {
    expect(await semverSatisfies(">= 5.7.0 <= 5.7.4", "5.7.5")).toBe(false);
  });

  // Additional bounded range tests with different whitespace patterns
  it("range >=5.7.0 <=5.7.4 (no spaces around operators) should satisfy version 5.7.3", async () => {
    expect(await semverSatisfies(">=5.7.0 <=5.7.4", "5.7.3")).toBe(true);
  });

  it("range >=  5.7.0  <=  5.7.4 (multiple spaces) should satisfy version 5.7.3", async () => {
    expect(await semverSatisfies(">=  5.7.0  <=  5.7.4", "5.7.3")).toBe(true);
  });

  it("range >= 1.0.0 <= 2.0.0 should satisfy version 1.5.0", async () => {
    expect(await semverSatisfies(">= 1.0.0 <= 2.0.0", "1.5.0")).toBe(true);
  });

  it("range >= 1.0.0 <= 2.0.0 should satisfy version 1.0.0", async () => {
    expect(await semverSatisfies(">= 1.0.0 <= 2.0.0", "1.0.0")).toBe(true);
  });

  it("range >= 1.0.0 <= 2.0.0 should satisfy version 2.0.0", async () => {
    expect(await semverSatisfies(">= 1.0.0 <= 2.0.0", "2.0.0")).toBe(true);
  });

  it("range >= 1.0.0 <= 2.0.0 should not satisfy version 0.9.9", async () => {
    expect(await semverSatisfies(">= 1.0.0 <= 2.0.0", "0.9.9")).toBe(false);
  });

  it("range >= 1.0.0 <= 2.0.0 should not satisfy version 2.0.1", async () => {
    expect(await semverSatisfies(">= 1.0.0 <= 2.0.0", "2.0.1")).toBe(false);
  });
};
