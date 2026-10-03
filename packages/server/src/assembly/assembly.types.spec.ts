import { defineTable } from "@hot-updater/plugin-core";
import { describe, expectTypeOf, it } from "vitest";

import {
  type ClientAccessPolicy,
  type ClientAccessRule,
  createHotUpdater,
  type CreateHotUpdaterOptions,
  type RemovedClientAccess,
} from "../createHotUpdaterCore";
import { definePlugin } from "../plugins/definePlugin";

const keys = definePlugin({
  id: "keys",
  provides: { clientAuth: true },
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: { ping: () => "pong" as const },
    clientAuth: { varyHeaders: ["x-key"], authenticate: async () => true },
  }),
});

const sso = definePlugin({
  id: "sso",
  provides: { clientAuth: true },
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: {},
    clientAuth: { varyHeaders: [], authenticate: async () => true },
  }),
});

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable({ id: { type: "string" } }, { key: ["id"] }),
  },
  init: ({ db }) => ({
    api: { read: (id: string) => db.findOne("notes", { id }) },
  }),
});

type Database = CreateHotUpdaterOptions["database"];

/** The callback is type-checked and never runs. */
const typeOnly = (check: (database: Database) => void) => void check;

describe("createHotUpdater types", () => {
  it("counts clientAuth plugins in a tuple and names the fix", () => {
    expectTypeOf<ClientAccessRule<readonly []>>().toEqualTypeOf<{
      readonly clientAccess: ClientAccessPolicy;
    }>();
    expectTypeOf<ClientAccessRule<readonly [typeof notes]>>().toEqualTypeOf<{
      readonly clientAccess: ClientAccessPolicy;
    }>();
    expectTypeOf<ClientAccessRule<readonly [typeof keys]>>().toEqualTypeOf<{
      readonly clientAccess?: 'Remove clientAccess: plugin "keys" provides clientAuth';
    }>();
    expectTypeOf<
      ClientAccessRule<readonly [typeof keys, typeof notes, typeof sso]>
    >().toEqualTypeOf<{
      readonly clientAuth: 'Keep one clientAuth plugin: "keys", "sso" all provide it';
    }>();
    expectTypeOf<
      ClientAccessRule<readonly (typeof keys | typeof notes)[]>
    >().toEqualTypeOf<{
      readonly clientAccess?: "Remove clientAccess: a plugin in this list may provide clientAuth";
    }>();
  });

  it("accepts exactly one policy source", () => {
    typeOnly((database) => {
      createHotUpdater({ database, plugins: [notes, keys] });
      createHotUpdater({ database, plugins: [notes], clientAccess: "public" });
      createHotUpdater({ database, clientAccess: "public" });
      // @ts-expect-error Neither a clientAuth plugin nor "public".
      createHotUpdater({ database, plugins: [notes] });
      createHotUpdater({
        database,
        plugins: [keys],
        // @ts-expect-error clientAuth and "public" together.
        clientAccess: "public",
      });
      // @ts-expect-error Two plugins provide clientAuth.
      createHotUpdater({ database, plugins: [keys, sso] });
    });
  });

  it("says what replaced a clientAccess object from before 1.0 where it is written", () => {
    expectTypeOf<ClientAccessPolicy>().toEqualTypeOf<
      "public" | RemovedClientAccess
    >();
    expectTypeOf<
      RemovedClientAccess["type"]
    >().toEqualTypeOf<'clientAccess objects were removed in 1.0: set clientAccess: "public", or add a plugin that provides clientAuth'>();
    typeOnly((database) => {
      // @ts-expect-error clientAccess objects were removed in 1.0.
      createHotUpdater({ database, clientAccess: { type: "public" } });
      createHotUpdater({
        database,
        // @ts-expect-error clientAccess objects were removed in 1.0.
        clientAccess: { type: "api-key", headerName: "x-client-key" },
      });
    });
  });

  it("rejects core passed as a plugin and a clientAuth the plugin did not declare", () => {
    const core = {
      kind: "core",
      id: "core",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
    } as const;
    typeOnly((database) => {
      createHotUpdater({
        database,
        // @ts-expect-error Core is built in; it is not a plugin.
        plugins: [core],
      });
    });
    definePlugin({
      id: "sneaky",
      schemaVersion: "1",
      schema: {},
      init: () => ({
        api: {},
        // @ts-expect-error Declare provides: { clientAuth: true } to return clientAuth.
        clientAuth: { varyHeaders: [], authenticate: async () => true },
      }),
    });
    definePlugin({
      id: "promised",
      provides: { clientAuth: true },
      schemaVersion: "1",
      schema: {},
      // @ts-expect-error A plugin that provides clientAuth must return it.
      init: () => ({ api: {} }),
    });
  });

  it("types clientCredential by the plugin's API, gates it on clientAuth, and takes no commands", () => {
    definePlugin({
      id: "counter",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: { count: () => 1 } }),
      cli: {
        // @ts-expect-error Plugins add no CLI commands.
        commands: [],
      },
    });
    definePlugin({
      id: "counter",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: { count: () => 1 } }),
      cli: {
        // @ts-expect-error Declare provides: { clientAuth: true } to add clientCredential.
        clientCredential: {
          label: "Key",
          header: "x-key",
          env: "KEY",
          generate: () => "key",
          provision: async () => "key",
        },
      },
    });
    definePlugin({
      id: "keyed",
      provides: { clientAuth: true },
      schemaVersion: "1",
      schema: {},
      init: () => ({
        api: { issue: async () => "key" },
        clientAuth: { varyHeaders: ["x-key"], authenticate: async () => true },
      }),
      cli: {
        clientCredential: {
          label: "Key",
          header: "x-key",
          env: "KEY",
          generate: () => "key",
          provision: (api) => api.issue(),
        },
      },
    });
  });

  it("types each plugin's API by id", () => {
    type Api = ReturnType<
      typeof createHotUpdater<readonly [typeof keys, typeof notes]>
    >["api"];
    expectTypeOf<keyof Api>().toEqualTypeOf<"keys" | "notes">();
    expectTypeOf<ReturnType<Api["keys"]["ping"]>>().toEqualTypeOf<"pong">();
    expectTypeOf<Parameters<Api["notes"]["read"]>>().toEqualTypeOf<
      [id: string]
    >();
  });
});
