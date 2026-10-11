import { defineTable } from "@hot-updater/plugin-core";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expectTypeOf, it } from "vitest";

import {
  type ClientAccessPolicy,
  type ClientAccessRule,
  createHotUpdater,
  type CreateHotUpdaterOptions,
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
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        plugins: [notes, keys],
      });
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        plugins: [notes],
        clientAccess: "public",
      });
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        clientAccess: "public",
      });
      // @ts-expect-error Neither a clientAuth plugin nor "public".
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        plugins: [notes],
      });
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        plugins: [keys],
        // @ts-expect-error clientAuth and "public" together.
        clientAccess: "public",
      });
      // @ts-expect-error Two plugins provide clientAuth.
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        plugins: [keys, sso],
      });
    });
  });

  it("requires storage", () => {
    typeOnly((database) => {
      // @ts-expect-error storage is required.
      createHotUpdater({ database, clientAccess: "public" });
    });
  });

  it("takes only public as clientAccess", () => {
    expectTypeOf<ClientAccessPolicy>().toEqualTypeOf<"public">();
    typeOnly((database) => {
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        // @ts-expect-error clientAccess is "public" or absent.
        clientAccess: { type: "public" },
      });
      createHotUpdater({
        database,
        storage: createReleaseCatalogTestStorage(),
        // @ts-expect-error clientAccess is "public" or absent.
        clientAccess: { type: "api-key", headerName: "x-client-key" },
      });
    });
  });

  it("rejects a clientAuth the plugin did not declare, and a declared one init does not return", () => {
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
