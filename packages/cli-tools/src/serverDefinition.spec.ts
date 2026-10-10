import {
  type AnyHotUpdaterPlugin,
  createMemoryAdapter,
  definePlugin,
  type HotUpdaterCoreApi,
  type ToolingDatabase,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  clientAuthOf,
  createMigrator,
  generateClientCredential,
  generateSchema,
  generatesSchema,
  isServerDefinition,
  provisionClientCredential,
  type ServerDefinition,
  serverDefinitionOf,
} from "./serverDefinition";

/** A server definition as `createHotUpdater` returns one, through the properties tooling reads. */
const definitionOf = (
  overrides: Partial<ServerDefinition> = {},
): ServerDefinition => ({
  database: { name: "memory", adapter: createMemoryAdapter() },
  plugins: [],
  clientPlugins: [],
  clientEndpoints: [],
  core: {} as HotUpdaterCoreApi,
  api: {},
  ...overrides,
});

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {},
  init: () => ({ api: { count: () => 0 } }),
});

const provision = vi.fn(
  async (_api: unknown, { existing }: { existing?: string }) =>
    existing ?? "generated",
);

/** A plugin that guards client routes with a key, as apiKeys() does. */
const keys = definePlugin({
  id: "keys",
  provides: { clientAuth: true },
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: { register: () => undefined },
    clientAuth: { varyHeaders: ["X-Key"], authenticate: async () => true },
  }),
  cli: {
    clientCredential: {
      label: "API key",
      header: "X-Key",
      env: "HOT_UPDATER_KEY",
      generate: () => "generated",
      provision,
    },
  },
});

/** The definition of a server whose client routes `keys` guards. */
const guarded = (plugins: readonly AnyHotUpdaterPlugin[] = [notes, keys]) =>
  definitionOf({
    plugins,
    clientAuth: { plugin: "keys", varyHeaders: ["x-key"] },
    api: { notes: {}, keys: "keys api" },
  });

describe("serverDefinitionOf", () => {
  it("reads a definition through its public properties", () => {
    const definition = definitionOf();

    expect(isServerDefinition(definition)).toBe(true);
    expect(serverDefinitionOf(definition)).toBe(definition);
  });

  it("says what a module must export instead, and to upgrade a server from before the properties", () => {
    expect(isServerDefinition({})).toBe(false);
    expect(() => serverDefinitionOf(null, "src/hotUpdater.ts")).toThrow(
      "src/hotUpdater.ts must export hotUpdater: the server createHotUpdater({ database, storage, plugins }) returns.",
    );
    // What createHotUpdater returned before rc.21.
    expect(() =>
      serverDefinitionOf({ adapterName: "kysely", handlers: {} }),
    ).toThrow(
      "exports a hotUpdater from an older @hot-updater/server. Upgrade @hot-updater/server to the version of hot-updater.",
    );
  });
});

describe("clientAuthOf", () => {
  it("is undefined when client routes are public", () => {
    const definition = definitionOf({ plugins: [notes] });

    expect(clientAuthOf(definition)).toBeUndefined();
    expect(generateClientCredential(definition)).toBeUndefined();
  });

  it("reads the policy's headers and the credential an app sends", () => {
    expect(clientAuthOf(guarded())).toEqual({
      plugin: "keys",
      varyHeaders: ["x-key"],
      credential: { label: "API key", header: "x-key", env: "HOT_UPDATER_KEY" },
    });
    expect(generateClientCredential(guarded())).toBe("generated");
  });

  it("refuses a clientAuth plugin that gives init no credential", () => {
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

    expect(() =>
      clientAuthOf(
        definitionOf({
          plugins: [sso],
          clientAuth: { plugin: "sso", varyHeaders: [] },
        }),
      ),
    ).toThrow('Plugin "sso" provides clientAuth but no cli.clientCredential');
  });
});

describe("provisionClientCredential", () => {
  it("is undefined when client routes are public", async () => {
    await expect(
      provisionClientCredential(definitionOf({ plugins: [notes] }), {
        env: {},
        name: "Init",
      }),
    ).resolves.toBeUndefined();
  });

  it("registers the credential an environment saved again through the plugin's API, and makes one otherwise", async () => {
    provision.mockClear();

    const created = await provisionClientCredential(guarded(), {
      env: {},
      name: "Init",
    });
    const again = await provisionClientCredential(guarded(), {
      env: { HOT_UPDATER_KEY: " saved\n" },
      name: "Init again",
    });

    expect(created).toEqual({
      label: "API key",
      header: "x-key",
      env: "HOT_UPDATER_KEY",
      value: "generated",
    });
    expect(again?.value).toBe("saved");
    expect(provision.mock.calls).toEqual([
      ["keys api", { name: "Init" }],
      ["keys api", { existing: "saved", name: "Init again" }],
    ]);
  });
});

describe("database tooling", () => {
  const migrator = { migrateToLatest: vi.fn() };
  const tooling = (database: Partial<ToolingDatabase>) =>
    definitionOf({
      database: { name: "memory", adapter: createMemoryAdapter(), ...database },
      plugins: [notes],
    });

  it("migrates core's tables and the plugins', and generates their schema", () => {
    const createMigratorFor = vi.fn(() => migrator as never);
    const generate = vi.fn(() => ({ code: "schema", path: "schema.ts" }));
    const definition = tooling({
      createMigrator: createMigratorFor,
      generateSchema: generate,
    });

    expect(createMigrator(definition)).toBe(migrator);
    expect(generatesSchema(definition)).toBe(true);
    expect(generateSchema(definition, "latest")).toEqual({
      code: "schema",
      path: "schema.ts",
    });
    const [[target]] = createMigratorFor.mock.calls as unknown as [
      [{ readonly settings: Record<string, string> }],
    ];
    expect(target.settings).toMatchObject({ "schema.notes": "1" });
    expect(generate).toHaveBeenCalledWith("latest", undefined, target);
  });

  it("names what a database without the tooling does instead", () => {
    expect(() => createMigrator(tooling({}))).toThrow(
      "The memory database has no migrator; its provider applies the schema.",
    );
    expect(() =>
      createMigrator(
        tooling({ generateSchema: () => ({ code: "", path: "" }) }),
      ),
    ).toThrow("run `hot-updater db generate`");
    expect(generatesSchema(tooling({}))).toBe(false);
    expect(() => generateSchema(tooling({}), "latest")).toThrow(
      "has no schema generator; run `hot-updater db migrate` instead.",
    );
  });
});
