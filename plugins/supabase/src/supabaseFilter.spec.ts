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

  it("escapes PostgREST wildcards for insensitive equality", () => {
    const filter = buildSupabaseFilter([
      {
        field: "message",
        value: "release_100%*",
        mode: "insensitive",
      },
    ]);

    expect(filter).toBe(String.raw`message.ilike."release\\_100\\%\\*"`);
  });
});
