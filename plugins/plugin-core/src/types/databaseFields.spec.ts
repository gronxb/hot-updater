import { describe, expect, it } from "vitest";

import { databaseFields } from "./databaseFields";

describe("database model fields", () => {
  it("exposes the core and official domain models", () => {
    const models = Object.keys(databaseFields);

    expect(models).toEqual([
      "bundles",
      "bundle_patches",
      "releases",
      "release_catalogs",
      "channels",
      "bundle_events",
      "client_access_keys",
    ]);
  });
});
