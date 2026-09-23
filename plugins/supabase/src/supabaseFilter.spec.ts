import { describe, expect, it } from "vitest";

import { buildSupabaseFilter } from "./supabaseFilter";

describe("buildSupabaseFilter", () => {
  it("quotes string equality values", () => {
    const filter = buildSupabaseFilter([
      { field: "message", value: 'say "hi" \\ bye' },
    ]);

    expect(filter).toBe(String.raw`message.eq."say \"hi\" \\ bye"`);
  });

  it("joins predicates left to right with and()", () => {
    const filter = buildSupabaseFilter([
      { field: "enabled", value: true },
      { field: "id", operator: "in", value: ["a", "b"] },
      { field: "target_app_version", value: null },
    ]);

    expect(filter).toBe(
      'and(and(enabled.eq.true,id.in.("a","b")),target_app_version.is.null)',
    );
  });

  it("makes an empty inclusion predicate match nothing", () => {
    expect(
      buildSupabaseFilter([{ field: "id", operator: "in", value: [] }]),
    ).toBe("and(id.is.null,id.not.is.null)");
  });
});
