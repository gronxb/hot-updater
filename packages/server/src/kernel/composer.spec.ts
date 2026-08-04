import {
  attachCapabilityContribution,
  defineCapability,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import { defineFirstPartyServerPlugin } from "./manifest";

const createRuntime = () =>
  createGuardedInfrastructureRuntime({
    database: createRuntimeDatabase(),
    storages: [],
  });

describe("composeServerKernel", () => {
  it("materializes capabilities before synchronous setup in plugin id order", () => {
    // Given
    const calls: string[] = [];
    const token = defineCapability({ id: "example@1", parse: String });
    const carrier = attachCapabilityContribution(
      {},
      {
        create: () => {
          calls.push("capability");
          return "ready";
        },
        token,
      },
    );
    const beta = defineFirstPartyServerPlugin({
      id: "beta",
      setup: ({ capabilities }) => {
        calls.push(`beta:${capabilities.require(token)}`);
        return {};
      },
    });
    const alpha = defineFirstPartyServerPlugin({
      id: "alpha",
      requires: [{ missing: "error", token }],
      setup: ({ capabilities, database }) => {
        calls.push(`alpha:${capabilities.get(token)}:${database.name}`);
        return {};
      },
    });

    // When
    const composed = composeServerKernel({
      carriers: [carrier],
      coreRoutes: [],
      plugins: [beta, alpha],
      runtime: createRuntime(),
    });

    // Then
    expect(calls).toEqual([
      "capability",
      "alpha:ready:testDatabase",
      "beta:ready",
    ]);
    expect(Object.isFrozen(composed)).toBe(true);
  });

  it("rejects duplicate plugin ids before setup", () => {
    // Given
    const setup = vi.fn(() => ({}));
    const first = defineFirstPartyServerPlugin({
      id: "duplicate",
      setup,
    });
    const second = defineFirstPartyServerPlugin({
      id: "duplicate",
      setup,
    });

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [first, second],
        runtime: createRuntime(),
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_PLUGIN_ID" }));
    expect(setup).not.toHaveBeenCalled();
  });

  it("combines core and plugin routes with one authentication provider", () => {
    // Given
    const coreRoute = {
      access: { kind: "public" },
      id: "core.version",
      method: "GET",
      path: "/version",
      async handle() {
        return new Response();
      },
    } as const;
    const authentication = {
      id: "auth",
      async authenticate() {
        return { kind: "anonymous" } as const;
      },
    };
    const plugin = defineFirstPartyServerPlugin({
      id: "feature",
      setup: () => ({
        authentication,
        routes: [
          {
            access: { kind: "protected" },
            id: "feature.route",
            method: "POST",
            path: "/feature",
            async handle() {
              return new Response();
            },
          },
        ],
      }),
    });

    // When
    const composed = composeServerKernel({
      carriers: [],
      coreRoutes: [coreRoute],
      plugins: [plugin],
      runtime: createRuntime(),
    });

    // Then
    expect(composed.router.routes.map(({ id }) => id)).toEqual([
      "core.version",
      "feature.route",
    ]);
    expect(composed.authentication).toBe(authentication);
  });

  it("rejects a strict missing capability before setup", () => {
    // Given
    const token = defineCapability({ id: "required@1", parse: String });
    const setup = vi.fn(() => ({}));
    const plugin = defineFirstPartyServerPlugin({
      id: "feature",
      requires: [{ missing: "error", token }],
      setup,
    });

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        details: { pluginId: "feature", tokenId: "required@1" },
      }),
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown field", () => ({ middleware: [] })],
    ["thenable", async () => ({})],
  ])("rejects an invalid %s contribution", (_name, setup) => {
    // Given
    const plugin = Reflect.apply(defineFirstPartyServerPlugin, undefined, [
      { id: "invalid", setup },
    ]);

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "invalid" },
      }),
    );
  });

  it("rejects a custom setup thenable without executing it", () => {
    // Given
    const then = vi.fn();
    const plugin = defineFirstPartyServerPlugin({
      id: "thenable",
      setup: () => Reflect.construct(Object, [{ then }]),
    });

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PLUGIN_CONTRIBUTION" }),
    );
    expect(then).not.toHaveBeenCalled();
  });
});
