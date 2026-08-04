import { describe, expectTypeOf, it } from "vitest";

import type { DatabaseBundleCursor, DatabaseBundleQueryOptions } from "./index";

describe("database bundle pagination types", () => {
  it("excludes competing cursor directions", () => {
    expectTypeOf<{
      readonly after: "004";
      readonly before: "002";
    }>().not.toMatchTypeOf<DatabaseBundleCursor>();
    expectTypeOf<
      Readonly<Record<string, never>>
    >().not.toMatchTypeOf<DatabaseBundleCursor>();
  });

  it("excludes page and cursor combinations", () => {
    expectTypeOf<{
      readonly limit: 2;
      readonly page: 2;
      readonly cursor: { readonly after: "004" };
    }>().not.toMatchTypeOf<DatabaseBundleQueryOptions>();
  });
});
