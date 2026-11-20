import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  formatManagedPlugins,
  MANAGED_PLUGIN_IDS,
  managedPlugins,
  parseManagedPlugins,
} from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

const serverOf = (selection: Parameters<typeof managedPlugins>[0]) =>
  createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: createReleaseCatalogTestStorage(),
    ...managedPlugins(selection),
  } as Parameters<typeof createHotUpdater>[0]);

describe("parseManagedPlugins", () => {
  it.each([undefined, "", "  "])(
    "selects every plugin for the missing selection %j, as servers deployed before it run them",
    (selection) => {
      expect(parseManagedPlugins(selection)).toEqual([
        "insights",
        "apiKeys",
        "remoteConfig",
      ]);
    },
  );

  it("selects no plugin for none", () => {
    expect(parseManagedPlugins("none")).toEqual([]);
  });

  it("reads the listed plugins in the order a managed server runs them", () => {
    expect(parseManagedPlugins(" remoteConfig, insights ,, ")).toEqual([
      "insights",
      "remoteConfig",
    ]);
    expect(parseManagedPlugins("apiKeys,apiKeys")).toEqual(["apiKeys"]);
  });

  it("refuses a plugin a managed server does not run, naming it", () => {
    expect(() => parseManagedPlugins("insights,analytics,none")).toThrow(
      'Unknown managed plugins "analytics", "none". List insights, apiKeys, remoteConfig separated by commas, or "none" to run no plugin.',
    );
  });
});

describe("formatManagedPlugins", () => {
  it.each([
    [[...MANAGED_PLUGIN_IDS], "insights,apiKeys,remoteConfig"],
    [["remoteConfig", "insights"] as const, "insights,remoteConfig"],
    [[], "none"],
  ])(
    "writes %j as the selection parseManagedPlugins reads back",
    (ids, text) => {
      expect(formatManagedPlugins(ids)).toBe(text);
      expect(formatManagedPlugins(parseManagedPlugins(text))).toBe(text);
    },
  );
});

describe("managedPlugins", () => {
  it("runs every plugin behind API keys when nothing is selected", () => {
    const options = managedPlugins(undefined);

    expect(options).not.toHaveProperty("clientAccess");
    const server = serverOf(undefined);
    expect(Object.keys(server.api)).toEqual([
      "insights",
      "apiKeys",
      "remoteConfig",
    ]);
    expect(server.clientAuth?.plugin).toBe("apiKeys");
  });

  it("leaves client routes public when the selection has no apiKeys", () => {
    expect(managedPlugins("insights,remoteConfig").clientAccess).toBe("public");

    const server = serverOf(["remoteConfig", "insights"]);
    expect(Object.keys(server.api)).toEqual(["insights", "remoteConfig"]);
    expect(server.clientAuth).toBeUndefined();
    expect(server.clientPlugins).toEqual([
      { module: "@hot-updater/react-native", name: "insights" },
    ]);
  });

  it("assembles a server that runs no plugin", () => {
    const server = serverOf("none");

    expect(Object.keys(server.api)).toEqual([]);
    expect(server.clientAuth).toBeUndefined();
    expect(server.clientPlugins).toEqual([]);
  });
});
