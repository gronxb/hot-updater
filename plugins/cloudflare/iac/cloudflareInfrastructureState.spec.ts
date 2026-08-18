import { describe, expect, it } from "vitest";

import {
  assertCloudflareInfrastructureCanInitialize,
  resolveCloudflareInfrastructureState,
} from "./cloudflareInfrastructureState";

describe("Cloudflare infrastructure generation", () => {
  it.each([
    [[], "fresh"],
    [["unrelated"], "fresh"],
    [["bundles"], "v0"],
    [["bundles", "release_catalogs"], "v1"],
  ] as const)("classifies %j as %s", (tables, expected) => {
    expect(resolveCloudflareInfrastructureState(tables)).toBe(expected);
  });

  it("blocks a selected v0 D1 database", () => {
    expect(() =>
      assertCloudflareInfrastructureCanInitialize(["bundles"], "legacy-db"),
    ).toThrow(
      "Cloudflare v0 infrastructure was detected at D1 database legacy-db",
    );
  });
});
