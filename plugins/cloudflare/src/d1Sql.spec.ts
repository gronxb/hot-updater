import { expect, it } from "vitest";

import { buildD1Where } from "./d1Sql";

it("joins predicates left to right with one json_each bind for sets", () => {
  const query = buildD1Where([
    { field: "enabled", value: true },
    { field: "id", operator: "in", value: ["a", "b"] },
    { field: "target_app_version", value: null },
  ]);

  expect(query.sql).toBe(
    " WHERE ((enabled = json_extract(?, '$') AND id IN (SELECT value FROM json_each(?))) AND target_app_version IS NULL)",
  );
  expect(query.params).toEqual(["true", '["a","b"]']);
});

it("makes an empty inclusion predicate deterministic", () => {
  expect(buildD1Where([{ field: "id", operator: "in", value: [] }]).sql).toBe(
    " WHERE 1 = 0",
  );
});
