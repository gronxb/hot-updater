import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { apiKeys } from "../plugins/api-keys";
import { definePlugin } from "../plugins/definePlugin";
import {
  clientAuthOf,
  generateClientCredential,
  pluginCommandsOf,
  provisionClientCredential,
} from "./pluginCli";

const run = async () => {};

const withCommands = (id: string, commands: readonly unknown[]) =>
  ({
    id,
    schemaVersion: "1",
    schema: {},
    init: () => ({ api: {} }),
    cli: { commands },
  }) as never;

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

describe("pluginCommandsOf", () => {
  it("lists each plugin's top-level commands with its plugin", () => {
    const entries = pluginCommandsOf([notes, apiKeys()]);
    expect(
      entries.map(({ plugin, command }) => [plugin, command.name]),
    ).toEqual([
      ["notes", "notes"],
      ["apiKeys", "api-key"],
    ]);
    expect(pluginCommandsOf([])).toEqual([]);
  });

  it.each([
    [
      [{ name: "Notes", description: "x", run }],
      'command "Notes" needs a name of lowercase words joined by hyphens',
    ],
    [[{ name: "notes", run }], "and a description"],
    [
      [{ name: "notes", description: "x" }],
      "needs either subcommands or run/runRemote, not both",
    ],
    [
      [{ name: "notes", description: "x", run, commands: [] }],
      "needs either subcommands or run/runRemote, not both",
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
    expect(() => pluginCommandsOf([withCommands("notes", commands)])).toThrow(
      message,
    );
  });

  it("refuses two plugins that add the same command", () => {
    expect(() =>
      pluginCommandsOf([
        notes,
        withCommands("other", [{ name: "notes", description: "x", run }]),
      ]),
    ).toThrow(
      'Plugins "notes" and "other" both add the command "notes"; keep one.',
    );
  });
});

describe("clientAuthOf", () => {
  it("is undefined when no plugin provides clientAuth", () => {
    expect(clientAuthOf([notes])).toBeUndefined();
    expect(generateClientCredential([notes])).toBeUndefined();
  });

  it("reads the policy's headers and the credential an app sends", () => {
    expect(clientAuthOf([notes, apiKeys({ headerName: "X-Key" })])).toEqual({
      plugin: "apiKeys",
      varyHeaders: ["x-key"],
      credential: {
        label: "API key",
        header: "x-key",
        env: "HOT_UPDATER_API_KEY",
      },
    });
    expect(generateClientCredential([apiKeys()])).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
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
    expect(() => clientAuthOf([sso])).toThrow(
      'Plugin "sso" provides clientAuth but no cli.clientCredential',
    );
  });
});

describe("provisionClientCredential", () => {
  const database = () => ({ name: "memory", adapter: createMemoryAdapter() });

  it("is undefined when client routes are public", async () => {
    await expect(
      provisionClientCredential(database(), [notes], {
        env: {},
        name: "Init",
      }),
    ).resolves.toBeUndefined();
  });

  it("registers a saved credential again, and creates one otherwise", async () => {
    const plugins = [apiKeys()];
    const target = database();
    const created = await provisionClientCredential(target, plugins, {
      env: {},
      name: "Init",
    });
    expect(created).toMatchObject({
      label: "API key",
      header: "x-api-key",
      env: "HOT_UPDATER_API_KEY",
      value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const again = await provisionClientCredential(target, plugins, {
      env: { HOT_UPDATER_API_KEY: ` ${created!.value}\n` },
      name: "Init again",
    });
    expect(again?.value).toBe(created!.value);
  });
});
