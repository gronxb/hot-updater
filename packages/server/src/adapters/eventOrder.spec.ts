import { DatabaseSync, type SqliteValue } from "node:sqlite";

import type {
  DatabasePluginCrud,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabasePluginCrud } from "../../../../plugins/plugin-core/src/databasePluginCrud";
import { createTableSql } from "../db/schema/sql";
import { createDrizzleCrud } from "./drizzleCrud";
import { createLazyDB } from "./drizzleLazyDB";
import { createKyselyCrud } from "./kyselyCrud";

const bundleId = "00000000-0000-7000-8000-000000000001";
const otherBundleId = "00000000-0000-7000-8000-000000000002";
const eventId = (prefix: "10000000" | "20000000", n: number): string =>
  `${prefix}-0000-7000-8000-${String(n).padStart(12, "0")}`;
const schema = {
  bundle_events: sqliteTable("bundle_events", {
    id: text("id").primaryKey().notNull(),
    type: text("type").notNull(),
    install_id: text("install_id").notNull(),
    user_id: text("user_id"),
    username: text("username"),
    from_release_id: text("from_release_id"),
    from_bundle_id: text("from_bundle_id"),
    to_release_id: text("to_release_id"),
    to_bundle_id: text("to_bundle_id").notNull(),
    platform: text("platform").notNull(),
    app_version: text("app_version").notNull(),
    channel: text("channel").notNull(),
    cohort: text("cohort").notNull(),
    update_strategy: text("update_strategy"),
    fingerprint_hash: text("fingerprint_hash"),
    sdk_version: text("sdk_version"),
    received_at_ms: integer("received_at_ms").notNull(),
  }),
  api_keys: sqliteTable("api_keys", {
    id: text("id").primaryKey(),
    hash: text("hash").notNull(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    role: text("role").notNull(),
    created_at_ms: integer("created_at_ms").notNull(),
    revoked_at_ms: integer("revoked_at_ms"),
  }),
  // The CRUD factory resolves these tables, but these read tests do not use them.
  bundles: sqliteTable("bundles", { id: text("id").primaryKey() }),
  bundle_patches: sqliteTable("bundle_patches", {
    id: text("id").primaryKey(),
  }),
  channels: sqliteTable("channels", { id: text("id").primaryKey() }),
  releases: sqliteTable("releases", { id: text("id").primaryKey() }),
  release_catalogs: sqliteTable("release_catalogs", {
    scope_key: text("scope_key").primaryKey(),
  }),
};

interface ExecutedQuery {
  readonly sql: string;
  readonly parameters: readonly SqliteValue[];
}

describe.each(["kysely", "drizzle"] as const)(
  "%s event index ordering",
  (name) => {
    const database = new DatabaseSync(":memory:");
    const queries: ExecutedQuery[] = [];
    let crud: DatabasePluginCrud;
    let dispose = async () => database.close();

    const read = (sql: string, parameters: readonly unknown[]) => {
      const values = parameters as readonly SqliteValue[];
      queries.push({ sql, parameters: values });
      return database.prepare(sql).all(...values);
    };

    beforeAll(() => {
      database.exec(createTableSql("sqlite").join(";"));
      database.exec(`
      with recursive n(value) as (
        select 0 union all select value + 1 from n where value < 50000
      )
      insert into bundle_events (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select printf('10000000-0000-7000-8000-%012d',value),
        'UNCHANGED','unrelated-install',null,'${otherBundleId}',
        'ios','1.0.0','production','default',null,value from n;
      with recursive n(value) as (
        select 0 union all select value + 1 from n where value < 102
      )
      insert into bundle_events (id,type,install_id,user_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select printf('20000000-0000-7000-8000-%012d',value),
        'UPDATE_APPLIED','install-a',
        case value when 1 then 'alice' when 2 then 'bob' else null end,
        '${otherBundleId}','${bundleId}',
        'ios','1.0.0','production','default','appVersion',60000 from n;
      insert into api_keys (id,hash,name,prefix,role,created_at_ms,revoked_at_ms)
      values ('key-0','hash-0','zero','prefix','client',0,null),
        ('key-1','hash-1','one','prefix','client',0,10),
        ('key-2','hash-2','two','prefix','client',0,20);
      analyze;
    `);
      if (name === "kysely") {
        const db = new Kysely<object>({
          dialect: new SqliteDialect({
            database: {
              close: () => database.close(),
              prepare: (sql) => {
                const statement = database.prepare(sql);
                return {
                  reader: statement.columns().length > 0,
                  all: (parameters) => read(sql, parameters),
                  run: (parameters) =>
                    statement.run(...(parameters as SqliteValue[])),
                  iterate: (parameters) =>
                    statement.iterate(...(parameters as SqliteValue[])),
                };
              },
            },
          }),
        });
        crud = createDatabasePluginCrud(createKyselyCrud(db, "sqlite"));
        dispose = () => db.destroy();
      } else {
        const db = drizzle(
          async (sql, parameters) => ({
            rows: read(sql, parameters).map((row) => Object.values(row)),
          }),
          { schema },
        );
        crud = createDatabasePluginCrud(
          createDrizzleCrud(createLazyDB({ db, provider: "sqlite" }), "sqlite"),
        );
      }
    });

    afterAll(() => dispose());

    it.each(["asc", "desc"] as const)(
      "seeks global, bundle and timestamp-tie pages in %s order without sorting history",
      async (direction) => {
        expect(
          database.prepare("select count(*) as total from bundle_events").get(),
        ).toEqual({ total: 50104 });
        const step = direction === "asc" ? 1 : -1;
        const expected = (prefix: "10000000" | "20000000", first: number) =>
          Array.from({ length: 51 }, (_, i) =>
            eventId(prefix, first + step * i),
          );
        const checkPage = async (
          where: readonly DatabaseWhere<"bundle_events">[],
          ids: readonly string[],
          indexes: readonly string[],
          nulls?: "first" | "last",
        ) => {
          queries.length = 0;
          const order = { direction, ...(nulls ? { nulls } : {}) };
          const rows = await crud.findMany({
            model: "bundle_events",
            where,
            orderBy: [
              { field: "received_at_ms", ...order },
              { field: "id", ...order },
            ],
            limit: 51,
            offset: 0,
          });
          expect(rows.map((row) => row.id)).toEqual(ids);
          expect(queries).toHaveLength(1);
          const query = queries[0]!;
          expect(query.sql).toMatch(/order by/i);
          expect(query.sql).not.toMatch(/is null/i);
          expect(query.sql).toMatch(/limit/i);
          const plan = database
            .prepare(`explain query plan ${query.sql}`)
            .all(...query.parameters)
            .map((row) => row.detail);
          expect(plan).toHaveLength(1);
          expect(plan[0]).toMatch(
            new RegExp(`USING INDEX (${indexes.join("|")})`),
          );
          expect(plan[0]).toMatch(/^SEARCH /);
          expect(plan.join(" ")).not.toMatch(/TEMP B-TREE|SCAN /);
        };
        const cutoff = {
          field: "received_at_ms",
          operator: "lt",
          value: 60001,
        } as const;
        await checkPage(
          [cutoff],
          direction === "asc"
            ? expected("10000000", 0)
            : expected("20000000", 102),
          ["bundle_events_received_at_idx"],
        );
        const tie = [
          { field: "received_at_ms", value: 60000 },
          {
            field: "id",
            operator: direction === "asc" ? "gt" : "lt",
            value: eventId("20000000", direction === "asc" ? 50 : 52),
          },
        ] as const;
        await checkPage(tie, expected("20000000", 51), [
          "bundle_events_received_at_idx",
        ]);
        const bundle = [
          { field: "type", value: "UPDATE_APPLIED" },
          { field: "to_bundle_id", value: bundleId },
        ] as const;
        await checkPage(
          [...bundle, cutoff],
          expected("20000000", direction === "asc" ? 0 : 102),
          ["bundle_events_to_bundle_idx"],
        );
        await checkPage(
          [...bundle, ...tie],
          expected("20000000", 51),
          // All 103 rows at this timestamp belong to this bundle, so SQLite
          // may choose either bounded index range for the tie continuation.
          ["bundle_events_to_bundle_idx", "bundle_events_received_at_idx"],
        );
        await checkPage(
          [
            cutoff,
            {
              field: "received_at_ms",
              operator: direction === "asc" ? "gt" : "lt",
              value: direction === "asc" ? 49900 : 100,
            },
          ],
          expected("10000000", direction === "asc" ? 49901 : 99),
          ["bundle_events_received_at_idx"],
          direction === "asc" ? "first" : "last",
        );
      },
    );

    it("preserves default and explicit nullable ordering on events and other models", async () => {
      const cases = [
        { direction: "asc", order: [1, 2, 0] },
        { direction: "desc", order: [0, 2, 1] },
        { direction: "asc", nulls: "first", order: [0, 1, 2] },
        { direction: "desc", nulls: "last", order: [2, 1, 0] },
      ] as const;
      for (const item of cases) {
        const nulls = "nulls" in item ? { nulls: item.nulls } : {};
        queries.length = 0;
        const events = await crud.findMany({
          model: "bundle_events",
          where: [
            {
              field: "id",
              operator: "in",
              value: [0, 1, 2].map((n) => eventId("20000000", n)),
            },
          ],
          orderBy: [
            { field: "user_id", direction: item.direction, ...nulls },
            { field: "id", direction: "asc" },
          ],
          limit: 3,
          offset: 0,
        });
        expect(events.map((row) => row.id)).toEqual(
          item.order.map((n) => eventId("20000000", n)),
        );
        expect(queries[0]!.sql).toMatch(/"user_id" is null/);
        expect(queries[0]!.sql).not.toMatch(/"id" is null/);
        const keys = await crud.findMany({
          model: "api_keys",
          orderBy: [
            { field: "revoked_at_ms", direction: item.direction, ...nulls },
            { field: "id", direction: "asc" },
          ],
          limit: 3,
          offset: 0,
        });
        expect(keys.map((row) => row.id)).toEqual(
          item.order.map((n) => `key-${n}`),
        );
        expect(queries[1]!.sql).toMatch(/"revoked_at_ms" is null/);
        expect(queries[1]!.sql).toMatch(/"id" is null/);
      }
    });
  },
);
