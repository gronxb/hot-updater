import type { InvocationAwareFeatureValue } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  projectFeatureApis,
  type FeatureInvocationRequest,
} from "./apiProjection";

type TestContext = Readonly<{ readonly id: string }>;
type PublicArityApi = Readonly<{
  short(context?: TestContext): string;
  wide(value: unknown, count?: number, context?: TestContext): unknown;
}>;

describe("feature API invocation arity acceptance", () => {
  it("pads omitted contexts at fixed indices across differing public arities", () => {
    // Given
    const requests: FeatureInvocationRequest<TestContext>[] = [];
    const context = Object.freeze({ id: "context" });
    const short = () => "short";
    const wide = (value: unknown) => value;
    const raw = {
      short,
      wide,
    } satisfies InvocationAwareFeatureValue<PublicArityApi, TestContext>;
    const projected = projectFeatureApis<TestContext>({
      contributions: [
        {
          invocation: {
            short: { contextIndex: 0, publicArity: 1 },
            wide: { contextIndex: 2, publicArity: 3 },
          },
          legacyAliases: { legacyWide: "wide" },
          namespace: "arity",
          value: {
            ...raw,
            status: "available",
          },
        },
      ],
      coreApiKeys: [],
      invoke(request) {
        requests.push(request);
        return Reflect.apply(request.raw, undefined, [
          ...request.args,
          Object.freeze({ privateInvocation: true }),
        ]);
      },
    });
    const feature = projected.features.arity;
    if (feature === undefined) throw new Error("Missing projected feature.");
    const projectedShort = Reflect.get(feature, "short");
    const projectedWide = Reflect.get(feature, "wide");
    const projectedAlias = Reflect.get(projected.aliases, "legacyWide");
    if (typeof projectedAlias !== "function") {
      throw new Error("Missing projected alias.");
    }

    // When
    const results = [
      Reflect.apply(projectedShort, undefined, []),
      Reflect.apply(projectedShort, undefined, [context]),
      Reflect.apply(projectedWide, undefined, ["omitted"]),
      Reflect.apply(projectedWide, undefined, ["supplied", 2, context]),
      Reflect.apply(projectedAlias, undefined, ["alias"]),
    ];

    // Then
    expect(results).toEqual(["short", "short", "omitted", "supplied", "alias"]);
    expect(short).toHaveLength(0);
    expect(wide).toHaveLength(1);
    expect(
      requests.map(({ args, context: requestContext, invokedAlias }) => ({
        args,
        context: requestContext,
        invokedAlias,
      })),
    ).toEqual([
      { args: [undefined], context: undefined, invokedAlias: undefined },
      { args: [context], context, invokedAlias: undefined },
      {
        args: ["omitted", undefined, undefined],
        context: undefined,
        invokedAlias: undefined,
      },
      {
        args: ["supplied", 2, context],
        context,
        invokedAlias: undefined,
      },
      {
        args: ["alias", undefined, undefined],
        context: undefined,
        invokedAlias: "legacyWide",
      },
    ]);
  });
});
