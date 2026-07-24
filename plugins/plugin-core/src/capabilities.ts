import type {
  DatabasePlugin,
  RuntimeStorageProfile,
  StoragePlugin,
} from "./types";

declare const capabilityTokenBrand: unique symbol;

export interface CapabilityToken<TValue> {
  readonly [capabilityTokenBrand]: TValue | undefined;
  readonly id: `${string}@${number}`;
  readonly parse: (value: unknown) => TValue;
}

export interface DefineCapabilityOptions<TValue> {
  readonly id: `${string}@${number}`;
  readonly parse: (value: unknown) => TValue;
}

const capabilityTokens = new WeakSet<object>();

export const defineCapability = <TValue>(
  options: DefineCapabilityOptions<TValue>,
): CapabilityToken<TValue> => {
  const token = Object.freeze({
    id: options.id,
    parse: options.parse,
  }) as CapabilityToken<TValue>;
  capabilityTokens.add(token);
  return token;
};

export type DatabaseCapabilityRuntime = Readonly<
  Pick<
    DatabasePlugin,
    | "name"
    | "create"
    | "update"
    | "delete"
    | "count"
    | "findOne"
    | "findMany"
    | "transaction"
  >
>;

export type RuntimeStorageAccess<TContext = unknown> = Readonly<
  Pick<StoragePlugin<TContext>, "name" | "supportedProtocol"> &
    RuntimeStorageProfile<TContext>
>;

export interface HotUpdaterInfrastructureRuntime<TContext = unknown> {
  readonly database: DatabaseCapabilityRuntime;
  readonly storages: readonly RuntimeStorageAccess<TContext>[];
}

export interface CapabilityContribution<TValue> {
  readonly token: CapabilityToken<TValue>;
  readonly create: (runtime: HotUpdaterInfrastructureRuntime) => unknown;
}

const emptyCapabilityContributions: readonly CapabilityContribution<unknown>[] =
  Object.freeze([]);
const capabilityContributionSnapshots = new WeakMap<
  object,
  readonly CapabilityContribution<unknown>[]
>();

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const isCapabilityToken = (value: unknown): value is CapabilityToken<unknown> =>
  isObject(value) &&
  capabilityTokens.has(value) &&
  typeof Reflect.get(value, "id") === "string" &&
  typeof Reflect.get(value, "parse") === "function";

const isCapabilityContribution = (
  value: unknown,
): value is CapabilityContribution<unknown> =>
  isObject(value) &&
  isCapabilityToken(Reflect.get(value, "token")) &&
  typeof Reflect.get(value, "create") === "function";

export class InvalidCapabilityCarrierError extends Error {
  readonly name = "InvalidCapabilityCarrierError";
}

const createImmutableCarrier = <TCarrier extends object>(
  carrier: TCarrier,
): TCarrier => {
  const forwardedFunctions = new Map<
    PropertyKey,
    {
      readonly bound: (...args: unknown[]) => unknown;
      readonly source: object;
    }
  >();
  const forwardValue = (key: PropertyKey, value: unknown): unknown => {
    if (typeof value !== "function" || key === "constructor") return value;
    const cached = forwardedFunctions.get(key);
    if (cached?.source === value) return cached.bound;
    const bound = (...args: unknown[]) => Reflect.apply(value, carrier, args);
    forwardedFunctions.set(key, { bound, source: value });
    return bound;
  };
  const target: object = Object.create(Reflect.getPrototypeOf(carrier));
  for (const key of Reflect.ownKeys(carrier)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(carrier, key);
    if (!descriptor) continue;
    Reflect.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => forwardValue(key, Reflect.get(carrier, key, carrier)),
    });
  }
  const wrapper = new Proxy(target, {
    get(current, key) {
      if (!Reflect.has(current, key)) return undefined;
      return forwardValue(key, Reflect.get(carrier, key, carrier));
    },
  });
  return Object.freeze(wrapper) as TCarrier;
};

export const getCapabilityContributions = (
  carrier: object,
): readonly CapabilityContribution<unknown>[] =>
  capabilityContributionSnapshots.get(carrier) ?? emptyCapabilityContributions;

export const attachCapabilityContribution = <TCarrier extends object, TValue>(
  carrier: TCarrier,
  contribution: CapabilityContribution<TValue>,
): TCarrier => {
  if (!isCapabilityContribution(contribution)) {
    throw new InvalidCapabilityCarrierError();
  }
  const nextContribution = Object.freeze({
    token: contribution.token,
    create: contribution.create,
  });
  const contributions = Object.freeze([
    ...getCapabilityContributions(carrier),
    nextContribution,
  ]);
  const attached = createImmutableCarrier(carrier);
  capabilityContributionSnapshots.set(attached, contributions);
  return attached;
};
