import { createRuntimeScope } from "./sessionRuntime.testFixtures";

export const maliciousScopeCases = (): readonly {
  readonly label: string;
  readonly create: (observeGetter: () => void) => unknown;
}[] => [
  { label: "null", create: () => null },
  { label: "a primitive", create: () => 7 },
  { label: "an array", create: () => [] },
  { label: "a date", create: () => new Date(0) },
  {
    label: "an inherited scope",
    create: () => Object.create(createRuntimeScope()),
  },
  {
    label: "a null-prototype scope",
    create: () => {
      const scope = Object.create(null);
      Reflect.set(scope, "tenantId", "tenant-a");
      Reflect.set(scope, "principalId", "principal-a");
      Reflect.set(scope, "context", { marker: "null-prototype" });
      return scope;
    },
  },
  {
    label: "a tenant accessor",
    create: (observeGetter) => {
      const scope = createRuntimeScope();
      Object.defineProperty(scope, "tenantId", {
        configurable: true,
        enumerable: true,
        get: () => {
          observeGetter();
          return "tenant-a";
        },
      });
      return scope;
    },
  },
  {
    label: "an alternating principal accessor",
    create: (observeGetter) => {
      const scope = createRuntimeScope();
      let calls = 0;
      Object.defineProperty(scope, "principalId", {
        configurable: true,
        enumerable: true,
        get: () => {
          observeGetter();
          calls += 1;
          return calls === 1 ? "principal-a" : "principal-b";
        },
      });
      return scope;
    },
  },
  {
    label: "a context accessor",
    create: (observeGetter) => {
      const scope = createRuntimeScope();
      Object.defineProperty(scope, "context", {
        configurable: true,
        enumerable: true,
        get: () => {
          observeGetter();
          return { marker: "accessor" };
        },
      });
      return scope;
    },
  },
  {
    label: "a non-enumerable field",
    create: () => {
      const scope = createRuntimeScope();
      Object.defineProperty(scope, "context", {
        configurable: true,
        enumerable: false,
        value: scope.context,
      });
      return scope;
    },
  },
  {
    label: "a symbol field",
    create: () => {
      const scope = createRuntimeScope();
      Reflect.set(scope, Symbol("scope"), true);
      return scope;
    },
  },
  {
    label: "an extra field",
    create: () => ({ ...createRuntimeScope(), unexpected: true }),
  },
  {
    label: "a missing context",
    create: () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
  },
  {
    label: "a missing tenant",
    create: () => ({ principalId: "principal-a", context: {} }),
  },
  {
    label: "a numeric principal",
    create: () => ({
      tenantId: "tenant-a",
      principalId: 7,
      context: {},
    }),
  },
  {
    label: "a whitespace tenant",
    create: () => ({
      tenantId: "   ",
      principalId: "principal-a",
      context: {},
    }),
  },
  {
    label: "a whitespace principal",
    create: () => ({
      tenantId: "tenant-a",
      principalId: "\t",
      context: {},
    }),
  },
];
