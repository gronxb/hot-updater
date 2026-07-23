import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("@hot-updater/test-utils package", () => {
  it("is publishable as a public package", () => {
    expect(Object.hasOwn(packageJson, "private")).toBe(false);
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });
});
