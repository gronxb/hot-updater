import { describe, expectTypeOf, it } from "vitest";

import type {
  FindAggregatesModel,
  FindManyModel,
  HotUpdaterDatabase,
  Lookup,
} from "./database";
import { defineAggregate, defineTable } from "./schema";

const schema = {
  bundles: defineTable(
    {
      id: { type: "string" },
      platform: { type: "string" },
      tag: { type: "string", required: false },
      hash: { type: "string", unique: true },
    },
    {
      key: ["id"],
      indexes: {
        byPlatform: { eq: ["platform"], sort: ["id"] },
        byTag: { eq: ["tag"], sort: ["id"] },
      },
    },
  ),
  totals: defineAggregate(
    { scope: { type: "string" } },
    {
      key: ["scope"],
      counters: ["hits"],
      indexes: { all: { eq: [], sort: ["scope"] } },
    },
  ),
} as const;

type Schema = typeof schema;

/** The callback is type-checked and never runs. */
const typeOnly = (check: (db: HotUpdaterDatabase<Schema>) => void) =>
  void check;

describe("database API types", () => {
  it("names the right read in its error text", () => {
    expectTypeOf<
      FindManyModel<Schema, "totals">
    >().toEqualTypeOf<"findMany reads tables; read aggregates with findAggregates">();
    expectTypeOf<
      FindAggregatesModel<Schema, "bundles">
    >().toEqualTypeOf<"findAggregates reads aggregates; read tables with findMany">();
    typeOnly((db) => {
      // @ts-expect-error Aggregates are read with findAggregates.
      void db.findMany("totals", { index: "all", where: {}, limit: 1 });
      void db.findAggregates(
        // @ts-expect-error Tables are read with findMany.
        "bundles",
        { index: "byPlatform", where: { platform: "ios" }, limit: 1 },
      );
    });
  });

  it("has no count, offset, or free-form filter", () => {
    expectTypeOf<keyof HotUpdaterDatabase<Schema>>().toEqualTypeOf<
      "findOne" | "findMany" | "findAggregates" | "transaction"
    >();
    typeOnly((db) => {
      // @ts-expect-error There is no count.
      void db.count;
      void db.findMany("bundles", {
        index: "byPlatform",
        where: { platform: "ios" },
        limit: 1,
        // @ts-expect-error There is no offset.
        offset: 5,
      });
    });
  });

  it("reads only declared indexes with every eq field bound to a value", () => {
    typeOnly((db) => {
      void db.findMany("bundles", {
        // @ts-expect-error byHash is not a declared index.
        index: "byHash",
        where: { platform: "ios", tag: "beta" },
        limit: 1,
      });
      void db.findMany("bundles", {
        index: "byPlatform",
        // @ts-expect-error byPlatform needs its platform field.
        where: {},
        limit: 1,
      });
      void db.findMany("bundles", {
        index: "byTag",
        // @ts-expect-error A sparse index never matches null.
        where: { tag: null },
        limit: 1,
      });
      void db.findMany("bundles", {
        index: "byTag",
        where: { tag: "beta" },
        limit: 1,
      });
    });
  });

  it("creates full rows and updates only non-key fields in a transaction", () => {
    typeOnly((db) => {
      void db.transaction(async (tx) => {
        tx.create("bundles", { id: "b", platform: "ios", hash: "h" });
        // @ts-expect-error hash is required.
        tx.create("bundles", { id: "b", platform: "ios" });
        const row = await tx.findOne("bundles", { id: "b" });
        if (row === null) return;
        tx.update("bundles", row, { tag: null });
        // @ts-expect-error Key fields cannot change.
        tx.update("bundles", row, { id: "c" });
        // @ts-expect-error Aggregates are not written through create.
        tx.create("totals", { scope: "s" });
      });
    });
  });

  it("finds one row only by its key or a unique field", () => {
    expectTypeOf<Lookup<Schema["bundles"]>>().toEqualTypeOf<
      { readonly id: string } | { readonly hash: string }
    >();
    typeOnly((db) => {
      // @ts-expect-error platform is neither the key nor unique.
      void db.findOne("bundles", { platform: "ios" });
      // @ts-expect-error findOne reads tables.
      void db.findOne("totals", { scope: "s" });
    });
  });
});
