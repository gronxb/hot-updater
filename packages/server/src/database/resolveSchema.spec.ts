import { DatabaseSchemaError } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { resolveSchema, validateSchema } from "./resolveSchema";
import { defineAggregate, defineTable, type ModuleSchema } from "./schema";

const parents = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    name: { type: "string", unique: true },
  },
  { key: ["id"], indexes: { all: { eq: [], sort: ["id"] } } },
);

const children = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    parent_id: {
      type: "string",
      maxLength: 36,
      references: { model: "parents", onDelete: "cascade" },
    },
    owner_id: {
      type: "string",
      required: false,
      references: { model: "parents", onDelete: "restrict" },
    },
    position: { type: "integer" },
    received_at_ms: { type: "integer" },
  },
  {
    key: ["id"],
    derived: {
      day: {
        type: "integer",
        compute: (row) =>
          row.received_at_ms - (row.received_at_ms % 86_400_000),
      },
      refs: {
        type: "string",
        multi: true,
        compute: (row) => [`parent:${row.parent_id}`],
      },
    },
    indexes: {
      byParent: {
        eq: ["parent_id"],
        sort: ["position"],
        root: { model: "parents" },
      },
      byRef: { eq: ["refs", "day"], sort: ["received_at_ms"] },
    },
  },
);

const totals = defineAggregate(
  { scope: { type: "string", maxLength: 64 }, bucket: { type: "integer" } },
  {
    key: ["scope", "bucket"],
    counters: ["hits"],
    shards: 4,
    indexes: { byScope: { eq: ["scope"], sort: ["bucket"] } },
  },
);

const core: ModuleSchema = { parents, children, totals };

describe("resolveSchema", () => {
  it("adds engine columns, unique-field indexes, reference counters, and roots", () => {
    const schema = resolveSchema([{ id: "core", schema: core }]);
    const parent = schema.models.get("parents")!;

    expect(parent.table.columns.map(({ name }) => name)).toEqual([
      "id",
      "name",
      "_refs_children_parent_id",
      "_refs_children_owner_id",
      "_v",
    ]);
    expect(parent.table.indexes).toEqual([
      { name: "all", eq: [], sort: ["id"] },
      { name: "name", eq: ["name"], sort: [], unique: true },
    ]);
    expect(
      parent.referencedBy.map(({ field, onDelete }) => [field, onDelete]),
    ).toEqual([
      ["parent_id", "cascade"],
      ["owner_id", "restrict"],
    ]);

    const child = schema.models.get("children")!;
    expect(child.roots).toEqual(new Map([["byParent", "parents"]]));
    expect(child.table.columns.find(({ name }) => name === "refs")).toEqual({
      name: "refs",
      type: "string",
      nullable: true,
      multi: true,
    });
    expect(
      child.table.columns.find(({ name }) => name === "owner_id"),
    ).toMatchObject({
      nullable: true,
    });
  });

  it("keys aggregates by identity then shard, with metrics as integers", () => {
    const aggregate = resolveSchema([{ id: "core", schema: core }]).models.get(
      "totals",
    )!;

    expect(aggregate.table.key).toEqual(["scope", "bucket", "_shard"]);
    expect(
      aggregate.table.columns.map(({ name, type }) => [name, type]),
    ).toEqual([
      ["scope", "string"],
      ["bucket", "integer"],
      ["_shard", "integer"],
      ["hits", "integer"],
      ["_v", "integer"],
    ]);
  });

  it("namespaces a third-party module's tables", () => {
    const schema = resolveSchema([
      { id: "core", schema: core },
      { id: "audit", namespace: "audit", schema: { parents, children } },
    ]);

    expect([...schema.models.keys()]).toEqual([
      "parents",
      "children",
      "totals",
      "audit_parents",
      "audit_children",
    ]);
    expect(schema.models.get("audit_children")!.references[0]).toMatchObject({
      target: "audit_parents",
      counter: "_refs_audit_children_parent_id",
    });
  });
});

describe("validateSchema", () => {
  const problems = (schema: ModuleSchema) => {
    try {
      validateSchema([{ id: "core", schema }]);
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseSchemaError);
      return (error as Error).message;
    }
    return "";
  };

  it("rejects nullable, json, and undeclared key fields", () => {
    const message = problems({
      rows: defineTable(
        { id: { type: "string", required: false }, meta: { type: "json" } },
        { key: ["id", "meta"] },
      ),
    });

    expect(message).toContain('core.rows: key field "id" is nullable');
    expect(message).toContain('core.rows: key field "meta" is json');
  });

  it("rejects a misordered aggregate key and mixed sketches", () => {
    const message = problems({
      totals: defineAggregate(
        { scope: { type: "string" }, bucket: { type: "integer" } },
        { key: ["bucket", "scope"], counters: ["hits"], distinct: ["users"] },
      ),
    });

    expect(message).toContain(
      "core.totals: key must list the identity fields in declaration order: scope, bucket",
    );
    expect(message).toContain(
      "core.totals: distinct sketches need an aggregate of their own",
    );
  });

  it("rejects bad roots, references, cascades without an index, and multi-valued sorts", () => {
    const message = problems({
      parents,
      children: defineTable(
        {
          id: { type: "string" },
          parent_id: {
            type: "integer",
            references: { model: "parents", onDelete: "cascade" },
          },
        },
        {
          key: ["id"],
          derived: {
            tags: { type: "string", multi: true, compute: () => ["a"] },
          },
          indexes: {
            byTag: { eq: [], sort: ["tags"] },
            rooted: { eq: ["id"], sort: [], root: { model: "missing" } },
          },
        },
      ),
    });

    expect(message).toContain(
      'index "byTag" sorts by multi-valued field "tags"',
    );
    expect(message).toContain(
      'index "rooted" is rooted at unknown table "missing"',
    );
    expect(message).toContain(
      'field "parent_id" and the key of "parents" differ in type',
    );
    expect(message).toContain(
      'cascade on "parent_id" needs an index whose eq starts with it',
    );
  });

  it("rejects duplicate table names across modules", () => {
    expect(() =>
      validateSchema([
        { id: "core", schema: { parents } },
        { id: "plugin", schema: { parents } },
      ]),
    ).toThrow(
      'plugin.parents: table "parents" is also declared by core.parents',
    );
  });
});
