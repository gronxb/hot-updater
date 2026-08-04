import { describe, expect, it, vi } from "vitest";

import {
  defineFirstPartyServerPlugin,
  isFirstPartyServerPlugin,
} from "./manifest";

describe("defineFirstPartyServerPlugin", () => {
  it("creates an immutable manifest recognized across module instances", async () => {
    // Given
    const first = await import("./manifest");
    const plugin = first.defineFirstPartyServerPlugin({
      id: "example",
      setup: () => ({}),
    });

    // When
    vi.resetModules();
    const second = await import("./manifest");

    // Then
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(second.isFirstPartyServerPlugin(plugin)).toBe(true);
  });

  it("publishes only a locked versioned process authority", () => {
    // Given
    const key = Symbol.for("@hot-updater/server/plugin-authority/v1");

    // When
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    const authority = descriptor?.value;

    // Then
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
    // Given
    const counterfeit = Object.freeze({
      id: "counterfeit",
      requires: Object.freeze([]),
      setup: () => ({}),
    });

    // When / Then
    expect(isFirstPartyServerPlugin(counterfeit)).toBe(false);
  });

  it("snapshots capability requirements", () => {
    // Given
    const requires: { readonly missing: "error"; readonly token: object }[] =
      [];
    const definition = {
      id: "example",
      requires,
      setup: () => ({}),
    };

    // When
    const plugin = Reflect.apply(defineFirstPartyServerPlugin, undefined, [
      definition,
    ]);
    requires.push({ missing: "error", token: {} });

    // Then
    expect(plugin.requires).toEqual([]);
    expect(Object.isFrozen(plugin.requires)).toBe(true);
  });
});
