import {
  attachCapabilityContribution,
  defineCapability,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { createCapabilityRegistry } from "./capabilityRegistry";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";

const runtime = () =>
  createGuardedInfrastructureRuntime({
    database: createRuntimeDatabase(),
    storages: [],
  });

describe("createCapabilityRegistry", () => {
  it("materializes and validates each capability synchronously", () => {
    // Given
    const parse = vi.fn((value: unknown) =>
      typeof value === "string" ? Object.freeze({ value }) : undefined,
    );
    const token = defineCapability({
      id: "example@1",
      parse(value) {
        const parsed = parse(value);
        if (parsed === undefined) throw new Error("invalid");
        return parsed;
      },
    });
    const create = vi.fn(() => "ready");
    const carrier = attachCapabilityContribution(
      { name: "database" },
      { create, token },
    );

    // When
    const registry = createCapabilityRegistry({
      carriers: [carrier],
      runtime: runtime(),
    });

    // Then
    expect(create).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledOnce();
    expect(registry.get(token)).toEqual({ value: "ready" });
    expect(registry.get(token)).toEqual({ value: "ready" });
    expect(registry.require(token)).toEqual({ value: "ready" });
    expect(registry.forPlugin("feature").get(token)).toEqual({
      value: "ready",
    });
    expect(registry.forPlugin("feature").require(token)).toEqual({
      value: "ready",
    });
    expect(parse).toHaveBeenCalledOnce();
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("rejects distinct token identities with the same ID before factories run", () => {
    // Given
    const create = vi.fn(() => "value");
    const first = defineCapability({
      id: "duplicate@1",
      parse: String,
    });
    const second = defineCapability({
      id: "duplicate@1",
      parse: String,
    });
    const carrier = attachCapabilityContribution(
      attachCapabilityContribution({}, { create, token: first }),
      { create, token: second },
    );

    // When / Then
    expect(() =>
      createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
    ).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_CAPABILITY_TOKEN_ID" }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("does not retrieve a value through a cloned token identity", () => {
    // Given
    const token = defineCapability({
      id: "identity@1",
      parse: String,
    });
    const clone = { ...token };
    const carrier = attachCapabilityContribution(
      {},
      { create: () => "value", token },
    );
    const registry = createCapabilityRegistry({
      carriers: [carrier],
      runtime: runtime(),
    });

    // When / Then
    expect(registry.get(clone)).toBeUndefined();
    expect(registry.has(clone)).toBe(false);
    expect(() => registry.forPlugin("feature").require(clone)).toThrowError(
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        details: { pluginId: "feature", tokenId: "identity@1" },
      }),
    );
  });

  it("rejects more than one provider for the same token", () => {
    // Given
    const token = defineCapability({
      id: "duplicate-provider@1",
      parse: String,
    });
    const carrier = attachCapabilityContribution(
      attachCapabilityContribution({}, { create: () => "first", token }),
      { create: () => "second", token },
    );

    // When / Then
    expect(() =>
      createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
    ).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_CAPABILITY_PROVIDER" }),
    );
  });

  it.each([
    ["invalid parsed value", () => Symbol("secret")],
    ["async factory", async () => "secret"],
  ])("maps an %s to an opaque typed construction error", (_name, create) => {
    // Given
    const token = defineCapability({
      id: "invalid@1",
      parse(value) {
        if (typeof value !== "string") throw new Error("provider secret");
        return value;
      },
    });
    const carrier = attachCapabilityContribution({}, { create, token });

    // When / Then
    expect(() =>
      createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CAPABILITY",
        details: { tokenId: "invalid@1" },
      }),
    );
  });

  it("throws a scoped missing-capability error from require", () => {
    // Given
    const token = defineCapability({
      id: "missing@1",
      parse: String,
    });
    const registry = createCapabilityRegistry({
      carriers: [],
      runtime: runtime(),
    });

    // When / Then
    expect(() => registry.forPlugin("feature").require(token)).toThrowError(
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        details: { pluginId: "feature", tokenId: "missing@1" },
      }),
    );
  });
});
