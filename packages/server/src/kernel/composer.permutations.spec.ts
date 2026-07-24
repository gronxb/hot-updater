import { describe, expect, it } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import { executeKernelRequest } from "./execute";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  type FirstPartyFeatureManifest,
} from "./manifest";
import { resolveVersionMetadata } from "./metadata";

interface PermutationFeatureKind extends FeatureApiKind {
  readonly availableApi: {
    readonly operation: () => string;
  };
  readonly feature: {
    readonly operation: () => string;
    readonly status: "available";
  };
}

const alpha = defineFirstPartyFeatureManifest<
  "alpha",
  PermutationFeatureKind,
  { readonly alphaOperation: "operation" }
>({
  aliases: { alphaOperation: "operation" },
  id: "alpha",
  namespace: "alpha",
  setup: () => ({
    api: {
      legacyAliases: { alphaOperation: "operation" },
      namespace: "alpha",
      value: {
        operation: () => "alpha",
        status: "available",
      },
    },
    metadata: [
      {
        keys: ["alphaEnabled"],
        namespace: "alpha",
        target: "capabilities",
        async resolve() {
          return { alphaEnabled: true };
        },
      },
    ],
    routes: [
      {
        access: { kind: "public" },
        id: "alpha.route",
        method: "GET",
        path: "/alpha",
        async handle() {
          return new Response("alpha");
        },
      },
    ],
  }),
  version: "1.0.0",
});

const authentication = defineFirstPartyFeatureManifest<
  "authentication",
  PermutationFeatureKind,
  Record<never, never>
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
          principal: { issuer: "test", subject: "user-1" },
        };
      },
    },
  }),
  version: "1.0.0",
});

const secure = defineFirstPartyFeatureManifest<
  "secure",
  PermutationFeatureKind,
  Record<never, never>
>({
  aliases: {},
  id: "secure",
  namespace: "secure",
  setup: () => ({
    middleware: [
      {
        id: "secure.middleware",
        phase: "post-auth",
        async handle(_context, next) {
          const response = await next();
          const headers = new Headers(response.headers);
          headers.set("x-kernel-middleware", "applied");
          return new Response(await response.text(), {
            headers,
            status: response.status,
          });
        },
      },
    ],
    routes: [
      {
        access: { kind: "protected" },
        id: "secure.route",
        method: "GET",
        path: "/secure",
        async handle(context) {
          return new Response(`secure:${context.principal?.subject}`);
        },
      },
    ],
  }),
  version: "1.0.0",
});

const permutations = <TFirst, TSecond, TThird>(
  values: readonly [TFirst, TSecond, TThird],
): readonly (readonly (TFirst | TSecond | TThird)[])[] => {
  const [first, second, third] = values;
  return [
    [first, second, third],
    [first, third, second],
    [second, first, third],
    [second, third, first],
    [third, first, second],
    [third, second, first],
  ];
};

const summarize = async (manifests: readonly FirstPartyFeatureManifest[]) => {
  const database = createRuntimeDatabase();
  const composed = composeServerKernel({
    carriers: [],
    manifests,
    runtime: createGuardedInfrastructureRuntime({
      database,
      storages: [],
    }),
  });
  const response = await executeKernelRequest({
    authentication: composed.authentication,
    basePath: "/api",
    middleware: composed.middleware,
    request: new Request("https://example.com/api/secure"),
    router: composed.router,
  });
  const metadata = await resolveVersionMetadata({
    compiled: composed.metadata,
  });
  if (metadata.kind === "response") {
    throw new Error("Metadata resolution failed.");
  }
  const alias = Reflect.get(composed.api.aliases, "alphaOperation");

  return {
    aliases: Object.keys(composed.api.aliases).sort(),
    api: Object.entries(composed.api.features)
      .map(([namespace, value]) => ({
        keys: Reflect.ownKeys(value).sort(),
        namespace,
        status: Reflect.get(value, "status"),
      }))
      .sort((left, right) => left.namespace.localeCompare(right.namespace)),
    behavior: {
      alias:
        typeof alias === "function"
          ? Reflect.apply(alias, undefined, [])
          : undefined,
      body: await response.text(),
      metadata: metadata.value,
      middleware: response.headers.get("x-kernel-middleware"),
      status: response.status,
    },
    frozen: {
      aliases: Object.isFrozen(composed.api.aliases),
      api: Object.isFrozen(composed.api),
      authentication: Object.isFrozen(composed.authentication),
      features:
        Object.isFrozen(composed.api.features) &&
        Object.values(composed.api.features).every(Object.isFrozen),
      metadata:
        Object.isFrozen(composed.metadata) &&
        Object.isFrozen(composed.metadata.contributions) &&
        composed.metadata.contributions.every(
          (item) =>
            Object.isFrozen(item) &&
            Object.isFrozen(item.keys) &&
            Object.isFrozen(item.optionalKeys),
        ),
      middleware:
        Object.isFrozen(composed.middleware) &&
        composed.middleware.every(Object.isFrozen),
      router:
        Object.isFrozen(composed.router) &&
        Object.isFrozen(composed.router.routes) &&
        composed.router.routes.every(
          (route) =>
            Object.isFrozen(route) &&
            Object.isFrozen(route.access) &&
            Object.isFrozen(route.segments),
        ),
    },
    metadata: composed.metadata.contributions.map(
      ({ keys, namespace, optionalKeys, target }) => ({
        keys,
        namespace,
        optionalKeys,
        target,
      }),
    ),
    middleware: composed.middleware.map(({ after, before, id, phase }) => ({
      after,
      before,
      id,
      phase,
    })),
    routes: composed.router.routes.map(({ access, id, method, path }) => ({
      access,
      id,
      method,
      path,
    })),
  };
};

describe("composeServerKernel permutation invariance", () => {
  it("compiles the same frozen plan and behavior for all manifest orders", async () => {
    const orders = permutations([alpha, authentication, secure]);
    const snapshots = await Promise.all(orders.map(summarize));
    const expected = snapshots[0];
    if (expected === undefined) throw new Error("Missing baseline.");

    for (const snapshot of snapshots) {
      expect(snapshot).toEqual(expected);
      expect(Object.values(snapshot.frozen).every(Boolean)).toBe(true);
    }
  });
});
