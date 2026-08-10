import { runInNewContext } from "node:vm";

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
  it("materializes and parses capabilities exactly once", () => {
    const parse = vi.fn((value: unknown) => {
      if (typeof value !== "string") throw new Error("invalid");
      return Object.freeze({ value });
    });
    const token = defineCapability({ id: "example@1", parse });
    const create = vi.fn(() => "ready");
    const carrier = attachCapabilityContribution({}, { create, token });

    const registry = createCapabilityRegistry({
      carriers: [carrier],
      runtime: runtime(),
    });

    expect(registry.get(token)).toEqual({ value: "ready" });
    expect(registry.require(token)).toEqual({ value: "ready" });
    expect(create).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledOnce();
  });

  it("does not materialize an explicitly excluded capability", () => {
    const token = defineCapability({ id: "excluded@1", parse: String });
    const create = vi.fn(() => "unused");
    const carrier = attachCapabilityContribution({}, { create, token });

    const registry = createCapabilityRegistry({
      carriers: [carrier],
      excludedTokens: [token],
      runtime: runtime(),
    });

    expect(registry.get(token)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects distinct token identities with the same id before factories run", () => {
    const create = vi.fn(() => "value");
    const first = defineCapability({ id: "duplicate@1", parse: String });
    const second = defineCapability({ id: "duplicate@1", parse: String });
    const carrier = attachCapabilityContribution(
      attachCapabilityContribution({}, { create, token: first }),
      { create, token: second },
    );

    expect(() =>
      createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
    ).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_CAPABILITY_TOKEN_ID" }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects duplicate providers for one token", () => {
    const token = defineCapability({
      id: "duplicate-provider@1",
      parse: String,
    });
    const carrier = attachCapabilityContribution(
      attachCapabilityContribution({}, { create: () => "first", token }),
      { create: () => "second", token },
    );

    expect(() =>
      createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
    ).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_CAPABILITY_PROVIDER" }),
    );
  });

  const asyncCases: readonly [
    string,
    () => unknown,
    (value: unknown) => unknown,
  ][] = [
    ["factory", async () => "secret", String],
    ["parser", () => "secret", async () => "secret"],
  ];

  it.each(asyncCases)(
    "rejects an async %s synchronously",
    (_name, create, parse) => {
      const token = defineCapability({ id: "async@1", parse });
      const carrier = attachCapabilityContribution({}, { create, token });

      expect(() =>
        createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_CAPABILITY",
          details: { tokenId: "async@1" },
        }),
      );
    },
  );

  it("rejects a custom thenable without executing it", () => {
    const then = vi.fn();
    const token = defineCapability({ id: "thenable@1", parse: String });
    const carrier = attachCapabilityContribution(
      {},
      { create: () => ({ then }), token },
    );

    expect(() =>
      createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CAPABILITY" }));
    expect(then).not.toHaveBeenCalled();
  });

  it.each(["factory", "parser"] as const)(
    "handles a rejected %s promise from another realm",
    async (source) => {
      const rejected = () =>
        runInNewContext('Promise.reject(new Error("capability rejected"))');
      const token = defineCapability({
        id: `cross-realm-${source}@1`,
        parse: source === "parser" ? rejected : String,
      });
      const carrier = attachCapabilityContribution(
        {},
        { create: source === "factory" ? rejected : () => "value", token },
      );

      expect(() =>
        createCapabilityRegistry({ carriers: [carrier], runtime: runtime() }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_CAPABILITY",
          details: { tokenId: `cross-realm-${source}@1` },
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  );

  it("scopes missing capability errors to the requiring plugin", () => {
    const token = defineCapability({ id: "missing@1", parse: String });
    const registry = createCapabilityRegistry({
      carriers: [],
      runtime: runtime(),
    });

    expect(() => registry.forPlugin("feature").require(token)).toThrowError(
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        details: { pluginId: "feature", tokenId: "missing@1" },
      }),
    );
  });
});
