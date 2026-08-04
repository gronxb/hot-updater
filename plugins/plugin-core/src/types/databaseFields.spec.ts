import { describe, expect, it } from "vitest";

import { databaseFields } from "./databaseFields";

describe("database model fields", () => {
  it("exposes only the Database V2 Core models", () => {
    const models = Object.keys(databaseFields);

    expect(models).toEqual(["bundles", "bundle_patches"]);
  });
});
