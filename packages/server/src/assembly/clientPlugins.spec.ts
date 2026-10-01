import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { apiKeys } from "../plugins/api-keys";
import { insights } from "../plugins/insights";
import { clientPluginsOf } from "./clientPlugins";

const withClientPlugin = (id: string, clientPlugin: unknown) =>
  ({
    id,
    schemaVersion: "1",
    schema: {},
    init: () => ({ api: {} }),
    cli: { clientPlugin },
  }) as never;

describe("clientPluginsOf", () => {
  it("lists each client plugin once, in plugin order", () => {
    expect(clientPluginsOf([apiKeys()])).toEqual([]);
    expect(
      clientPluginsOf([
        withClientPlugin("feedback", { module: "feedback-rn", name: "fb" }),
        insights(),
        apiKeys(),
        withClientPlugin("again", { module: "feedback-rn", name: "fb" }),
      ]),
    ).toEqual([
      { module: "feedback-rn", name: "fb" },
      {
        module: "@hot-updater/react-native",
        name: "insights",
      },
    ]);
  });

  it.each([
    [{ module: "", name: "fb" }],
    [{ module: "feedback-rn", name: "fb()" }],
    [{ module: "feedback-rn", name: "default" }],
    [{ module: "feedback-rn", name: "HotUpdater" }],
    [{ module: "feedback-rn", name: "App" }],
    ["feedback-rn"],
  ])("refuses a client plugin the app cannot import (%j)", (value) => {
    expect(() =>
      clientPluginsOf([withClientPlugin("feedback", value)]),
    ).toThrow(
      'Plugin "feedback" cli.clientPlugin needs a module and an export name the app can import',
    );
  });

  it("refuses two client plugins with one name from different modules", () => {
    expect(() =>
      clientPluginsOf([
        withClientPlugin("a", { module: "a-rn", name: "fb" }),
        withClientPlugin("b", { module: "b-rn", name: "fb" }),
      ]),
    ).toThrow(
      'Plugin "b" names the client plugin "fb" from b-rn, but another plugin names it from a-rn.',
    );
  });
});

describe("Hot Updater's reserved plugin ids in a definition", () => {
  const reserved = "which is reserved for Hot Updater's";
  const database = () => ({ name: "memory", adapter: createMemoryAdapter() });

  it("gives tooling the credential and client plugin of Hot Updater's own plugins", () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [insights(), apiKeys()],
    });

    expect(hotUpdater.clientAuth?.plugin).toBe("apiKeys");
    expect(hotUpdater.clientPlugins).toEqual([
      { module: "@hot-updater/react-native", name: "insights" },
    ]);
  });

  it("refuses a plugin that takes a reserved id without being Hot Updater's own", () => {
    const spoofedKeys = {
      id: "apiKeys",
      namespace: false,
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
      cli: { commands: [] },
    };

    expect(() =>
      createHotUpdater({
        database: database(),
        plugins: [insights(), spoofedKeys],
        clientAccess: "public",
      } as never),
    ).toThrow(
      `plugins[1] takes the id "apiKeys", ${reserved} apiKeys() plugin`,
    );
    expect(() => clientPluginsOf([{ ...insights() }])).toThrow(
      `plugins[0] takes the id "insights", ${reserved} insights() plugin`,
    );
  });
});
