import { describe, expect, it } from "vitest";

import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import { mongoAdapter } from "./mongodb";
import { createMongoBundleWhere } from "./mongodbQuery";
import { createMongoTestHarness } from "./mongodbTestClient";

const harness = createMongoTestHarness();

setupDatabaseAdapterTestSuite({
  name: "mongoAdapter v2",
  migrate: () => undefined,
  createAdapter: () => mongoAdapter({ client: harness.client }),
  reset: () => harness.reset(),
  dispose: () => harness.close(),
});

describe("mongoAdapter capabilities", () => {
  it("returns an adapter object without an unsafe transaction fallback", () => {
    const adapter = mongoAdapter({ client: harness.client });

    expect(adapter).toBeTypeOf("object");
    expect(adapter.name).toBe("mongodb");
    expect(adapter.adapterName).toBe("mongodb");
    expect(adapter.provider).toBe("mongodb");
    expect(adapter.transaction).toBeUndefined();
  });
});

describe("MongoDB query translation", () => {
  it("composes connectors left to right", () => {
    const where = createMongoBundleWhere([
      { field: "id", value: "first" },
      { field: "id", value: "second", connector: "OR" },
      { field: "enabled", value: true, connector: "AND" },
    ]);

    expect(where).toEqual({
      $and: [
        {
          $or: [
            { $expr: { $eq: ["$id", "first"] } },
            { $expr: { $eq: ["$id", "second"] } },
          ],
        },
        { $expr: { $eq: ["$enabled", true] } },
      ],
    });
  });

  it("escapes insensitive string pattern predicates", () => {
    const where = createMongoBundleWhere([
      {
        field: "message",
        operator: "contains",
        value: "release.*",
        mode: "insensitive",
      },
    ]);

    expect(where).toEqual({
      $expr: {
        $regexMatch: {
          input: { $ifNull: ["$message", ""] },
          regex: "release\\.\\*",
          options: "i",
        },
      },
    });
  });

  it("preserves empty set semantics", () => {
    expect(
      createMongoBundleWhere([{ field: "id", operator: "in", value: [] }]),
    ).toEqual({ $expr: { $in: ["$id", []] } });
    expect(
      createMongoBundleWhere([{ field: "id", operator: "not_in", value: [] }]),
    ).toEqual({ $expr: { $not: [{ $in: ["$id", []] }] } });
  });
});
