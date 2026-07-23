import { expect, it } from "vitest";

import { buildD1Where } from "./d1Sql";

it("composes predicates left to right with one json_each bind for sets", () => {
  const query = buildD1Where([
    { field: "enabled", value: true },
    { field: "id", operator: "in", value: ["a", "b"], connector: "OR" },
    {
      field: "target_app_version",
      operator: "ne",
      value: null,
      connector: "AND",
    },
  ]);

  expect(query.sql).toBe(
    " WHERE ((enabled = json_extract(?, '$') OR id IN (SELECT value FROM json_each(?))) AND target_app_version IS NOT NULL)",
  );
  expect(query.params).toEqual(["true", '["a","b"]']);
});

it("makes empty inclusion and exclusion predicates deterministic", () => {
  expect(buildD1Where([{ field: "id", operator: "in", value: [] }]).sql).toBe(
    " WHERE 1 = 0",
  );
  expect(
    buildD1Where([{ field: "id", operator: "not_in", value: [] }]).sql,
  ).toBe(" WHERE 1 = 1");
});
