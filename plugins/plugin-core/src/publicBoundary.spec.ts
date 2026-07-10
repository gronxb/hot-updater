import { describe, expect, it } from "vitest";

import * as publicApi from "./index";
import * as internalApi from "./internal";

describe("plugin-core public database boundary", () => {
  it("hides the low-level database factory from the root export", () => {
    expect(Reflect.has(publicApi, "createDatabasePlugin")).toBe(false);
  });

  it("keeps the low-level database factory available to internal runtime code", () => {
    expect(Reflect.has(internalApi, "createDatabasePlugin")).toBe(true);
    expect(Reflect.get(internalApi, "createDatabasePlugin")).toEqual(
      expect.any(Function),
    );
  });
});
