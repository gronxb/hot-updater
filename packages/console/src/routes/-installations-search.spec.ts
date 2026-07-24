import { describe, expect, it } from "vitest";

import { validateInstallationsSearch } from "./-installations-search";

describe("validateInstallationsSearch", () => {
  it("accepts non-negative integer pagination offsets", () => {
    expect(
      validateInstallationsSearch({
        query: "ada",
        installId: "install-1",
        searchOffset: 20,
        historyOffset: 50,
      }),
    ).toEqual({
      query: "ada",
      installId: "install-1",
      searchOffset: 20,
      historyOffset: 50,
    });
  });

  it.each([-1, 1.5, "20", Number.POSITIVE_INFINITY])(
    "resets invalid pagination offset %j",
    (offset) => {
      expect(
        validateInstallationsSearch({
          searchOffset: offset,
          historyOffset: offset,
        }),
      ).toMatchObject({ searchOffset: 0, historyOffset: 0 });
    },
  );
});
