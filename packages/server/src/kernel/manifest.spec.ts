import { defineUniversalComponentSchema } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  defineFirstPartyServerPlugin,
  isFirstPartyServerPlugin,
} from "./manifest";

describe("defineFirstPartyServerPlugin", () => {
  it("creates an immutable manifest recognized across module instances", async () => {
    const first = await import("./manifest");
    const plugin = first.defineFirstPartyServerPlugin({
      id: "example",
      setup: () => ({}),
    });

    vi.resetModules();
    const second = await import("./manifest");

    expect(Object.isFrozen(plugin)).toBe(true);
    expect(second.isFirstPartyServerPlugin(plugin)).toBe(true);
  });

  it("publishes only a locked versioned process authority", () => {
    const key = Symbol.for("@hot-updater/server/plugin-authority/v1");

    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    const authority = descriptor?.value;

    expect(descriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(
      Reflect.ownKeys(authority).sort((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    ).toEqual(["define", "is", "version"]);
    expect(Reflect.get(authority, "version")).toBe(1);
  });

  it("rejects a structural counterfeit", () => {
    const counterfeit = Object.freeze({
      id: "counterfeit",
      requires: Object.freeze([]),
      setup: () => ({}),
    });

    expect(isFirstPartyServerPlugin(counterfeit)).toBe(false);
  });

  it("snapshots capability requirements", () => {
    const requires: { readonly missing: "error"; readonly token: object }[] =
      [];
    const definition = {
      id: "example",
      requires,
      setup: () => ({}),
    };

    const plugin = Reflect.apply(defineFirstPartyServerPlugin, undefined, [
      definition,
    ]);
    requires.push({ missing: "error", token: {} });

    expect(plugin.requires).toEqual([]);
    expect(Object.isFrozen(plugin.requires)).toBe(true);
  });

  it("publishes an immutable static component schema contribution", () => {
    const schema = defineUniversalComponentSchema({
      id: "audit-log",
      versions: [
        {
          version: "1",
          tables: [
            {
              name: "audit_records",
              columns: [{ name: "id", primaryKey: true, type: "string" }],
            },
          ],
        },
      ],
    });
    const plugin = defineFirstPartyServerPlugin({
      id: "audit-plugin",
      schema,
      setup: () => ({}),
    });

    expect(plugin.schema).toBe(schema);
    expect(Object.isFrozen(plugin.schema)).toBe(true);
  });
});
