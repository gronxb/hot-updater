import { describe, expect, it } from "vitest";

import {
  binding,
  ConfigReferenceError,
  createStorageOperationContext,
  env,
  isConfigReference,
  resolveConfigReference,
  secret,
} from "./configReference";
import { NIL_UUID } from "./index";

function getConfigReferenceError(action: () => unknown): ConfigReferenceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigReferenceError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected ConfigReferenceError");
}

describe("core root export baseline", () => {
  it("keeps the established NIL_UUID root export unchanged", () => {
    expect(NIL_UUID).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("config references", () => {
  it("resolves environment and secret references for every target and bindings only outside node", () => {
    const targets = ["node", "worker", "functions", "edge"] as const;

    for (const target of targets) {
      const liveBinding = { count: 0 };
      const context = createStorageOperationContext({
        target,
        environment: { ENV_VALUE: "environment", SECRET_VALUE: "secret" },
        bindings: { LIVE: liveBinding },
      });

      expect(resolveConfigReference(env("ENV_VALUE"), context)).toBe(
        "environment",
      );
      expect(resolveConfigReference(secret("SECRET_VALUE"), context)).toBe(
        "secret",
      );

      if (target === "node") {
        expect(
          getConfigReferenceError(() =>
            resolveConfigReference(binding("LIVE"), context),
          ).code,
        ).toBe("wrong-target");
      } else {
        expect(resolveConfigReference(binding("LIVE"), context)).toBe(
          liveBinding,
        );
      }
    }
  });

  it("infers a binding value from its context map", () => {
    const context = createStorageOperationContext({
      target: "worker",
      environment: {},
      bindings: { LIVE: { count: 0 } },
    });
    const resolved: { readonly count: number } = resolveConfigReference<{
      readonly count: number;
    }>(binding("LIVE"), context);

    expect(resolved.count).toBe(0);
  });

  it("creates frozen tagged references with valid identifier names", () => {
    const reference = env("API_URL");

    expect(reference).toEqual({
      $type: "hot-updater.config-reference",
      kind: "env",
      name: "API_URL",
    });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.getPrototypeOf(reference)).toBe(Object.prototype);
    expect(isConfigReference(reference)).toBe(true);
    expect(
      isConfigReference({
        $type: "hot-updater.config-reference",
        kind: "env",
        name: "invalid-name",
      }),
    ).toBe(false);
  });

  it("resolves literals and injected environment and binding values", () => {
    const statefulBinding = {
      count: 0,
      increment() {
        this.count += 1;
      },
    };
    const context = createStorageOperationContext({
      target: "worker",
      environment: { API_URL: "https://api.example.invalid", TOKEN: "token" },
      bindings: { BUCKET: statefulBinding },
    });
    const literal = { mode: "literal" };

    expect(resolveConfigReference(literal, context)).toBe(literal);
    expect(resolveConfigReference<string>(env("API_URL"), context)).toBe(
      "https://api.example.invalid",
    );
    expect(resolveConfigReference<string>(secret("TOKEN"), context)).toBe(
      "token",
    );
    expect(
      resolveConfigReference<typeof statefulBinding>(
        binding("BUCKET"),
        context,
      ),
    ).toBe(statefulBinding);
  });

  it("freezes context maps while preserving live binding identity and state", () => {
    const statefulBinding = {
      count: 0,
      increment() {
        this.count += 1;
      },
    };
    const environment = { API_URL: "https://api.example.invalid" };
    const bindings = { BUCKET: statefulBinding };
    const context = createStorageOperationContext({
      target: "worker",
      environment,
      bindings,
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.environment)).toBe(true);
    expect(Object.isFrozen(context.bindings)).toBe(true);
    expect(context.environment).not.toBe(environment);
    expect(context.bindings).not.toBe(bindings);
    expect(context.bindings.BUCKET).toBe(statefulBinding);
    expect(Object.isFrozen(statefulBinding)).toBe(false);

    statefulBinding.increment();

    expect(context.bindings.BUCKET.count).toBe(1);
  });

  it("reports invalid names, missing values, and node bindings with typed safe errors", () => {
    const canary = "storage-v2-canary-value";
    const workerContext = createStorageOperationContext({
      target: "worker",
      environment: { PRESENT_SECRET: canary },
      bindings: {},
    });
    const nodeContext = createStorageOperationContext({
      target: "node",
      environment: {},
      bindings: { BUCKET: { count: 0 } },
    });

    const invalidNameError = getConfigReferenceError(() => env("invalid-name"));
    const missingError = getConfigReferenceError(() =>
      resolveConfigReference<string>(secret("MISSING_SECRET"), workerContext),
    );
    const wrongTargetError = getConfigReferenceError(() =>
      resolveConfigReference<{ readonly count: number }>(
        binding("BUCKET"),
        nodeContext,
      ),
    );

    expect(invalidNameError.code).toBe("invalid-name");
    expect(missingError.code).toBe("missing");
    expect(missingError.kind).toBe("secret");
    expect(missingError.referenceName).toBe("MISSING_SECRET");
    expect(`${missingError} ${JSON.stringify(missingError)}`).not.toContain(
      canary,
    );
    expect(wrongTargetError.code).toBe("wrong-target");
  });

  it("rejects malformed context target, maps, and environment values", () => {
    expect(() =>
      Reflect.apply(createStorageOperationContext, undefined, [
        { target: "browser", environment: {}, bindings: {} },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(createStorageOperationContext, undefined, [
        { target: "node", environment: null, bindings: {} },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(createStorageOperationContext, undefined, [
        { target: "node", environment: { API_URL: 1 }, bindings: {} },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(createStorageOperationContext, undefined, [
        { target: "node", environment: {}, bindings: [] },
      ]),
    ).toThrow(TypeError);
  });
});
