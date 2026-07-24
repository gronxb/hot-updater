import {
  attachCapabilityContribution,
  defineCapability,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  type FirstPartyFeatureManifest,
} from "./manifest";

interface EmptyFeatureKind extends FeatureApiKind {
  readonly availableApi: object;
  readonly feature: object;
}

const runtime = () => {
  const database = createRuntimeDatabase();
  return createGuardedInfrastructureRuntime({ database, storages: [] });
};

const manifest = (id: string, namespace: string) =>
  defineFirstPartyFeatureManifest<
    typeof namespace,
    EmptyFeatureKind,
    Record<never, never>
  >({
    aliases: {},
    id,
    namespace,
    setup: () => ({}),
    version: "1.0.0",
  });

const malformedManifest = (contribution: object) => {
  const value = { ...manifest("feature", "feature") };
  Reflect.set(value, "setup", () => contribution);
  return value;
};

const forbiddenContributions: ReadonlyArray<{
  readonly label: string;
  readonly value: object;
}> = [
  { label: "schema", value: { schema: {} } },
  { label: "migrations", value: { migrations: [] } },
  { label: "lifecycle", value: { lifecycle: {} } },
  { label: "init", value: { init: () => undefined } },
  { label: "dispose", value: { dispose: () => undefined } },
  { label: "cleanup", value: { cleanup: () => undefined } },
  { label: "pre-auth hook", value: { preAuth: () => undefined } },
  {
    label: "pre-auth middleware",
    value: { preAuthMiddleware: [] },
  },
  { label: "protect", value: { protect: () => undefined } },
  { label: "authorize", value: { authorize: () => undefined } },
  { label: "capabilities", value: { capabilities: [] } },
  {
    label: "route without access",
    value: {
      routes: [
        {
          id: "missing-access",
          method: "GET",
          path: "/missing-access",
          async handle() {
            return new Response("invalid");
          },
        },
      ],
    },
  },
];

describe("composeServerKernel invalid contributions", () => {
  it.each(forbiddenContributions)(
    "rejects a forbidden $label contribution",
    ({ value }) => {
      expect(() =>
        composeServerKernel({
          carriers: [],
          manifests: [malformedManifest(value)],
          runtime: runtime(),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_PLUGIN_CONTRIBUTION",
          details: { pluginId: "feature" },
        }),
      );
    },
  );

  it("rejects duplicate plugin IDs before setup with safe details", () => {
    const setup = vi.fn();
    const first = { ...manifest("duplicate", "first") };
    const second = { ...manifest("duplicate", "second") };
    Reflect.set(first, "setup", setup);
    Reflect.set(second, "setup", setup);

    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [second, first],
        runtime: runtime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "DUPLICATE_PLUGIN_ID",
        details: { pluginId: "duplicate" },
      }),
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it("rejects an unbranded runtime value without leaking it", () => {
    const manifests: FirstPartyFeatureManifest[] = [];
    Reflect.set(manifests, 0, {
      id: { secret: "must-not-leak" },
      requires: [],
    });

    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests,
        runtime: runtime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "<invalid>" },
        message:
          "Hot Updater construction failed (INVALID_PLUGIN_CONTRIBUTION).",
      }),
    );
  });

  it("materializes and parses capabilities before valid feature setup", () => {
    const trace: string[] = [];
    const token = defineCapability({
      id: "ordered@1",
      parse(value) {
        trace.push("parse");
        return String(value);
      },
    });
    const carrier = attachCapabilityContribution(
      {},
      {
        create() {
          trace.push("factory");
          return "ready";
        },
        token,
      },
    );
    const feature = defineFirstPartyFeatureManifest<
      "ordered",
      EmptyFeatureKind,
      Record<never, never>
    >({
      aliases: {},
      id: "ordered",
      namespace: "ordered",
      requires: [{ missing: "error", token }],
      setup() {
        trace.push("setup");
        return {};
      },
      version: "1.0.0",
    });

    composeServerKernel({
      carriers: [carrier],
      manifests: [feature],
      runtime: runtime(),
    });

    expect(trace).toEqual(["factory", "parse", "setup"]);
  });
});
