import {
  type AnyHotUpdaterPlugin,
  createMemoryAdapter,
  createStorageAdapter,
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
  managedServerDefinitionOf,
  pluginCommandsOf,
  provisionClientCredential,
  type ServerDefinition,
  serverDefinitionOf,
} from "./serverDefinition";

const run = async () => {};

/** A server definition as `createHotUpdater` returns one, through the properties tooling reads. */
const definitionOf = (
  overrides: Partial<ServerDefinition> = {},
): ServerDefinition => ({
  database: { name: "memory", adapter: createMemoryAdapter() },
  storage: [],
  plugins: [],
  clientPlugins: [],
  clientEndpoints: [],
  core: {} as HotUpdaterCoreApi,
  api: {},
  ...overrides,
});

const withCommands = (id: string, commands: readonly unknown[]) =>
  ({
    id,
    schemaVersion: "1",
    schema: {},
    init: () => ({ api: {} }),
    cli: { commands },
  }) as unknown as AnyHotUpdaterPlugin;

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {},
  init: () => ({ api: { count: () => 0 } }),
  cli: {
    commands: [
      {
        name: "notes",
        description: "Manage notes",
        commands: [
          {
            name: "count",
            description: "Count notes",
            async run({ api, ui }) {
              ui.print(String(api.count()));
            },
          },
        ],
      },
    ],
  },
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
    commands: [{ name: "key", description: "Manage keys", run }],
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

describe("pluginCommandsOf", () => {
  it("lists each plugin's top-level commands with its plugin", () => {
    const entries = pluginCommandsOf(definitionOf({ plugins: [notes, keys] }));

    expect(
      entries.map(({ plugin, command }) => [plugin, command.name]),
    ).toEqual([
      ["notes", "notes"],
      ["keys", "key"],
    ]);
    expect(pluginCommandsOf(definitionOf())).toEqual([]);
  });

  it.each([
    [
      [{ name: "Notes", description: "x", run }],
      'command "Notes" needs a name of lowercase words joined by hyphens',
    ],
    [[{ name: "notes", run }], "and a description"],
    [
      [{ name: "notes", description: "x" }],
      "needs either subcommands or run, not both",
    ],
    [
      [{ name: "notes", description: "x", run, commands: [] }],
      "needs either subcommands or run, not both",
    ],
    [[{ name: "notes", description: "x", commands: [] }], "at least one"],
    [
      [
        {
          name: "notes",
          description: "x",
          commands: [
            { name: "add", description: "x", run },
            { name: "add", description: "y", run },
          ],
        },
      ],
      'has two subcommands named "add"',
    ],
    [
      [
        {
          name: "notes",
          description: "x",
          arguments: [{ name: "configPath", description: "x" }],
          run,
        },
      ],
      'other than "configPath"',
    ],
    [
      [
        {
          name: "notes",
          description: "x",
          options: [{ flags: "-y", description: "x" }],
          run,
        },
      ],
      "needs --flags and a description",
    ],
  ])("refuses a malformed command (%#)", (commands, message) => {
    expect(() =>
      pluginCommandsOf(
        definitionOf({ plugins: [withCommands("notes", commands)] }),
      ),
    ).toThrow(message);
  });

  it("refuses two plugins that add the same command", () => {
    expect(() =>
      pluginCommandsOf(
        definitionOf({
          plugins: [
            notes,
            withCommands("other", [{ name: "notes", description: "x", run }]),
          ],
        }),
      ),
    ).toThrow(
      'Plugins "notes" and "other" both add the command "notes"; keep one.',
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

describe("managedServerDefinitionOf", () => {
  const cloudflare = {
    provider: "Cloudflare",
    database: "d1Database",
    storage: "r2",
    resources: { database: { databaseId: "d1-id" } },
  } as const;
  const r2 = createStorageAdapter({ name: "r2Storage", protocol: "r2" });
  const d1 = (resource?: Record<string, string>) => ({
    name: "d1Database",
    adapter: createMemoryAdapter(),
    ...(resource === undefined ? {} : { resource }),
  });

  it("gives back a definition on the managed server's database, storage, and resources", () => {
    const definition = definitionOf({
      database: d1({ databaseId: "d1-id" }),
      storage: [r2],
      plugins: [notes],
    });

    expect(managedServerDefinitionOf(definition, cloudflare)).toBe(definition);
  });

  it("refuses a database, storage, or resource the managed server does not run on", () => {
    expect(() =>
      managedServerDefinitionOf(
        definitionOf({
          database: { ...d1(), name: "postgres" },
          storage: [r2],
        }),
        cloudflare,
      ),
    ).toThrow(
      "The managed Cloudflare server runs on d1Database, but the server definition's database is postgres.",
    );
    expect(() =>
      managedServerDefinitionOf(
        definitionOf({
          database: d1(),
          storage: [
            r2,
            createStorageAdapter({ name: "s3Storage", protocol: "s3" }),
          ],
        }),
        cloudflare,
      ),
    ).toThrow(
      "stores bundles in its r2 storage, but the server definition's storage is r2Storage, s3Storage.",
    );
    expect(() =>
      managedServerDefinitionOf(
        definitionOf({ database: d1({ databaseId: "other" }), storage: [r2] }),
        cloudflare,
      ),
    ).toThrow(
      "The managed Cloudflare server runs on databaseId d1-id, which its setup made, but the server definition's d1Database has databaseId other",
    );
    expect(() => managedServerDefinitionOf({}, cloudflare)).toThrow(
      "The server definition must export hotUpdater",
    );
  });
});
