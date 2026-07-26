import { describe, expect, it } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import type { HotUpdaterServerRoute } from "./contracts";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import {
  defineFirstPartyFeatureManifest,
  type FirstPartyFeatureManifest,
  type NoFeatureApiKind,
} from "./manifest";

const infrastructure = () => {
  const database = createRuntimeDatabase();
  return createGuardedInfrastructureRuntime({
    database,
    storages: [],
  });
};

const publicRoute = (
  id: string,
  path: `/${string}`,
): HotUpdaterServerRoute => ({
  access: { kind: "public" },
  id,
  method: "GET",
  path,
  async handle() {
    return new Response(id);
  },
});

const policyManifest = (id = "policy") =>
  defineFirstPartyFeatureManifest<string, NoFeatureApiKind, {}>({
    aliases: {},
    id,
    namespace: id,
    setup: () => ({ routePolicy: { kind: "protect-all" } }),
    version: "1.0.0",
  });

describe("composeServerKernel route policy", () => {
  it("protects core and future plugin routes with frozen copies", () => {
    // Given
    const authentication = defineFirstPartyFeatureManifest<
      "authentication",
      NoFeatureApiKind,
      {}
    >({
      aliases: {},
      id: "authentication",
      namespace: "authentication",
      setup: () => ({
        authentication: {
          id: "test-authentication",
          async authenticate() {
            return {
              kind: "authenticated",
              principal: { issuer: "test", subject: "user" },
            };
          },
        },
      }),
      version: "1.0.0",
    });
    const feature = defineFirstPartyFeatureManifest<
      "feature-route",
      NoFeatureApiKind,
      {}
    >({
      aliases: {},
      id: "feature-route",
      namespace: "feature-route",
      setup: () => ({
        routes: [publicRoute("feature.route", "/feature")],
      }),
      version: "1.0.0",
    });

    const summarize = (manifests: readonly FirstPartyFeatureManifest[]) =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [publicRoute("core.route", "/core")],
        manifests,
        runtime: infrastructure(),
      }).router.routes.map((route) => ({
        access: route.access,
        frozen: Object.isFrozen(route) && Object.isFrozen(route.access),
        id: route.id,
      }));

    // When
    const forward = summarize([policyManifest(), feature, authentication]);
    const reversed = summarize([authentication, feature, policyManifest()]);
    const repeated = summarize([
      policyManifest("policy-second"),
      feature,
      authentication,
      policyManifest(),
    ]);

    // Then
    const expected = [
      {
        access: { kind: "protected" },
        frozen: true,
        id: "core.route",
      },
      {
        access: { kind: "protected" },
        frozen: true,
        id: "feature.route",
      },
    ];
    expect(forward).toEqual(expected);
    expect(reversed).toEqual(expected);
    expect(repeated).toEqual(expected);
  });

  it("requires authentication when protect-all is contributed", () => {
    // Given
    const coreRoute = publicRoute("core.route", "/core");

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [coreRoute],
        manifests: [policyManifest()],
        runtime: infrastructure(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );
  });
});
