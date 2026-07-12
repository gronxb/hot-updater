import { describe, expect, it } from "vitest";

import { buildSupabaseFilter } from "./supabaseFilter";

describe("buildSupabaseFilter", () => {
  it("places negation on the PostgREST operator when comparison is insensitive", () => {
    const filter = buildSupabaseFilter([
      {
        field: "message",
        operator: "ne",
        value: "Release",
        mode: "insensitive",
      },
    ]);

    expect(filter).toBe('message.not.ilike."Release"');
  });
});
