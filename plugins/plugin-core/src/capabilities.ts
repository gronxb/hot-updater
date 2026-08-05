import type { DatabasePlugin, StorageResolveContext } from "./types";

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

export interface RuntimeStorageAccess<TContext = unknown> {
  readonly name: string;
  readonly supportedProtocol: string;
  getDownloadUrl(
    storageUri: string,
    context?: StorageResolveContext<TContext>,
  ): Promise<{ readonly fileUrl: string }>;
  readText(
    storageUri: string,
    context?: StorageResolveContext<TContext>,
  ): Promise<string | null>;
}

/**
 * Frozen infrastructure access passed to capability factories.
 *
 * Runtime storage methods preserve the caller's platform context while hiding
 * provider profiles, configuration, and credentials.
 */
export interface HotUpdaterInfrastructureRuntime<TContext = unknown> {
  readonly database: DatabaseCapabilityRuntime;
  readonly storages: readonly RuntimeStorageAccess<TContext>[];
}

export interface CapabilityContribution<TValue> {
  readonly token: CapabilityToken<TValue>;
  readonly create: (runtime: HotUpdaterInfrastructureRuntime) => unknown;
}

const capabilityAuthorityKey = Symbol.for(
  "@hot-updater/plugin-core/capability-authority/v1",
);
const capabilityAuthorityVersion = 1;
const capabilityAuthorityMethods = [
  "attach",
  "define",
  "defineShared",
  "get",
] as const;
const capabilityIdPattern = /^[^@]+@[0-9]+$/;
const emptyCapabilityContributions: readonly CapabilityContribution<unknown>[] =
  Object.freeze([]);

type NonCallableCarrier<TCarrier extends object> = TCarrier extends (
  ...args: never[]
) => unknown
  ? never
  : TCarrier;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const validateCapabilityOptions = <TValue>(
  options: DefineCapabilityOptions<TValue>,
): void => {
  if (
    !isObject(options) ||
    capabilityIdPattern.exec(options.id)?.[0] !== options.id ||
    typeof options.parse !== "function"
  ) {
    throw new TypeError(
      "Capability options require a name@integer id and parser.",
    );
  }
};

export class InvalidCapabilityCarrierError extends Error {
  readonly name = "InvalidCapabilityCarrierError";
}

class InvalidCapabilityAuthorityError extends Error {
  readonly name = "InvalidCapabilityAuthorityError";
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

const createCapabilityAuthority = () => {
  const capabilityTokens = new WeakSet<object>();
  const capabilityContributionSnapshots = new WeakMap<
    object,
    readonly CapabilityContribution<unknown>[]
  >();
  const sharedCapabilityTokens = new Map<string, CapabilityToken<unknown>>();

  const define = <TValue>(
    options: DefineCapabilityOptions<TValue>,
  ): CapabilityToken<TValue> => {
    validateCapabilityOptions(options);
    const token = Object.freeze({
      id: options.id,
      parse: options.parse,
    }) as CapabilityToken<TValue>;
    capabilityTokens.add(token);
    return token;
  };

  return Object.freeze({
    attach<TCarrier extends object, TValue>(
      carrier: TCarrier,
      contribution: CapabilityContribution<TValue>,
    ): TCarrier | undefined {
      if (!isObject(carrier) || !isObject(contribution)) return undefined;
      const token = Reflect.get(contribution, "token");
      const create = Reflect.get(contribution, "create");
      if (
        !isObject(token) ||
        !capabilityTokens.has(token) ||
        typeof Reflect.get(token, "id") !== "string" ||
        typeof Reflect.get(token, "parse") !== "function" ||
        typeof create !== "function"
      ) {
        return undefined;
      }
      const nextContribution = Object.freeze({ create, token });
      const contributions = Object.freeze([
        ...(capabilityContributionSnapshots.get(carrier) ??
          emptyCapabilityContributions),
        nextContribution,
      ]);
      const attached = createImmutableCarrier(carrier);
      capabilityContributionSnapshots.set(attached, contributions);
      return attached;
    },
    define,
    defineShared<TValue>(
      options: DefineCapabilityOptions<TValue>,
    ): CapabilityToken<TValue> {
      validateCapabilityOptions(options);
      const existing = sharedCapabilityTokens.get(options.id);
      if (existing !== undefined) {
        return existing as CapabilityToken<TValue>;
      }
      const token = define(options);
      sharedCapabilityTokens.set(options.id, token);
      return token;
    },
    get: (carrier: object) =>
      capabilityContributionSnapshots.get(carrier) ??
      emptyCapabilityContributions,
    version: capabilityAuthorityVersion,
  });
};

type CapabilityAuthority = ReturnType<typeof createCapabilityAuthority>;

const isCapabilityAuthority = (value: unknown): value is CapabilityAuthority =>
  isObject(value) &&
  Object.isFrozen(value) &&
  Reflect.ownKeys(value).length === capabilityAuthorityMethods.length + 1 &&
  capabilityAuthorityMethods.every(
    (method) =>
      Object.hasOwn(value, method) &&
      typeof Reflect.get(value, method) === "function",
  ) &&
  Object.hasOwn(value, "version") &&
  Reflect.get(value, "version") === capabilityAuthorityVersion;

const resolveCapabilityAuthority = (): CapabilityAuthority => {
  const descriptor = Reflect.getOwnPropertyDescriptor(
    globalThis,
    capabilityAuthorityKey,
  );
  if (descriptor !== undefined) {
    if (
      descriptor.configurable ||
      descriptor.enumerable ||
      descriptor.writable ||
      !isCapabilityAuthority(descriptor.value)
    ) {
      throw new InvalidCapabilityAuthorityError();
    }
    return descriptor.value;
  }

  const authority = createCapabilityAuthority();
  if (
    !Reflect.defineProperty(globalThis, capabilityAuthorityKey, {
      configurable: false,
      enumerable: false,
      value: authority,
      writable: false,
    })
  ) {
    throw new InvalidCapabilityAuthorityError();
  }
  return authority;
};

const capabilityAuthority = resolveCapabilityAuthority();

export const defineCapability = <TValue>(
  options: DefineCapabilityOptions<TValue>,
): CapabilityToken<TValue> => capabilityAuthority.define(options);

/**
 * Defines a process-shared nominal token. Each versioned ID must keep the same
 * value type and parser semantics across every module instance. Change the ID
 * version when either contract changes.
 */
export const defineSharedCapability = <TValue>(
  options: DefineCapabilityOptions<TValue>,
): CapabilityToken<TValue> => capabilityAuthority.defineShared(options);

export const getCapabilityContributions = (
  carrier: object,
): readonly CapabilityContribution<unknown>[] =>
  capabilityAuthority.get(carrier);

export const attachCapabilityContribution = <TCarrier extends object, TValue>(
  carrier: NonCallableCarrier<TCarrier>,
  contribution: CapabilityContribution<TValue>,
): TCarrier => {
  const attached = capabilityAuthority.attach(carrier, contribution);
  if (attached === undefined) throw new InvalidCapabilityCarrierError();
  return attached;
};
