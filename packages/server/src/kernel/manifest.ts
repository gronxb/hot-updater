import type {
  CapabilityToken,
  DatabaseCapabilityRuntime,
} from "@hot-updater/plugin-core";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterServerPlugin,
  HotUpdaterServerRoute,
} from "./contracts";
import { serverPluginBrand } from "./contracts";

export type HotUpdaterCapabilityRequirement = {
  readonly missing: "continue" | "error";
  readonly token: CapabilityToken<unknown>;
};

export interface HotUpdaterPluginCapabilities {
  get<TValue>(token: CapabilityToken<TValue>): TValue | undefined;
  require<TValue>(token: CapabilityToken<TValue>): TValue;
}

export type HotUpdaterPluginSetupContext = {
  readonly capabilities: HotUpdaterPluginCapabilities;
  readonly database: DatabaseCapabilityRuntime;
};

export type HotUpdaterPluginContribution = {
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly routes?: readonly HotUpdaterServerRoute[];
};

export interface FirstPartyServerPlugin extends HotUpdaterServerPlugin {
  readonly id: string;
  readonly requires: readonly HotUpdaterCapabilityRequirement[];
  readonly setup: (context: HotUpdaterPluginSetupContext) => unknown;
  readonly version: string;
}

export type FirstPartyServerPluginDefinition = {
  readonly id: string;
  readonly requires?: readonly HotUpdaterCapabilityRequirement[];
  readonly setup: (
    context: HotUpdaterPluginSetupContext,
  ) => HotUpdaterPluginContribution;
  readonly version: string;
};

const pluginAuthorityKey = Symbol.for(
  "@hot-updater/server/plugin-authority/v1",
);
const pluginAuthorityVersion = 1;
const pluginAuthorityMethods = ["define", "is"] as const;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const createPluginAuthority = () => {
  const plugins = new WeakSet<object>();

  return Object.freeze({
    define(
      definition: FirstPartyServerPluginDefinition,
    ): FirstPartyServerPlugin {
      const requires = Object.freeze(
        (definition.requires ?? []).map((requirement) =>
          Object.freeze({
            missing: requirement.missing,
            token: requirement.token,
          }),
        ),
      );
      const plugin: FirstPartyServerPlugin = Object.freeze({
        [serverPluginBrand]: undefined,
        id: definition.id,
        requires,
        setup: definition.setup,
        version: definition.version,
      });
      plugins.add(plugin);
      return plugin;
    },
    is(value: unknown): value is FirstPartyServerPlugin {
      return isObject(value) && plugins.has(value);
    },
    version: pluginAuthorityVersion,
  });
};

type PluginAuthority = ReturnType<typeof createPluginAuthority>;

const isPluginAuthority = (value: unknown): value is PluginAuthority =>
  isObject(value) &&
  Object.isFrozen(value) &&
  Reflect.ownKeys(value).length === pluginAuthorityMethods.length + 1 &&
  pluginAuthorityMethods.every(
    (method) =>
      Object.hasOwn(value, method) &&
      typeof Reflect.get(value, method) === "function",
  ) &&
  Object.hasOwn(value, "version") &&
  Reflect.get(value, "version") === pluginAuthorityVersion;

const resolvePluginAuthority = (): PluginAuthority => {
  const descriptor = Reflect.getOwnPropertyDescriptor(
    globalThis,
    pluginAuthorityKey,
  );
  if (descriptor !== undefined) {
    if (
      descriptor.configurable ||
      descriptor.enumerable ||
      descriptor.writable ||
      !isPluginAuthority(descriptor.value)
    ) {
      throw new TypeError("Invalid server plugin process authority.");
    }
    return descriptor.value;
  }

  const authority = createPluginAuthority();
  if (
    !Reflect.defineProperty(globalThis, pluginAuthorityKey, {
      configurable: false,
      enumerable: false,
      value: authority,
      writable: false,
    })
  ) {
    throw new TypeError("Unable to install server plugin process authority.");
  }
  return authority;
};

const pluginAuthority = resolvePluginAuthority();

export const defineFirstPartyServerPlugin = (
  definition: FirstPartyServerPluginDefinition,
): FirstPartyServerPlugin => pluginAuthority.define(definition);

export const isFirstPartyServerPlugin = (
  value: unknown,
): value is FirstPartyServerPlugin => pluginAuthority.is(value);
