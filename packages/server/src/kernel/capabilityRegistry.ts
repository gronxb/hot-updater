import type {
  CapabilityToken,
  HotUpdaterInfrastructureRuntime,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";

import { HotUpdaterConstructionError } from "./errors";
import type { HotUpdaterPluginCapabilities } from "./manifest";

export interface CapabilityRegistry extends HotUpdaterPluginCapabilities {
  forPlugin(pluginId: string): HotUpdaterPluginCapabilities;
  has(token: CapabilityToken<unknown>): boolean;
}

export type CreateCapabilityRegistryOptions = {
  readonly carriers: readonly object[];
  readonly requiredTokens?: readonly CapabilityToken<unknown>[];
  readonly runtime: HotUpdaterInfrastructureRuntime;
};

function invalidCapability(tokenId: string): never {
  throw new HotUpdaterConstructionError("INVALID_CAPABILITY", { tokenId });
}

function rejectThenable(value: unknown, tokenId: string): void {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  ) {
    if (value instanceof Promise) {
      void value.catch(() => undefined);
    }
    invalidCapability(tokenId);
  }
}

export const createCapabilityRegistry = (
  options: CreateCapabilityRegistryOptions,
): CapabilityRegistry => {
  const contributions = options.carriers.flatMap((carrier) => {
    try {
      return [...getCapabilityContributions(carrier)];
    } catch {
      throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
        pluginId: "<infrastructure>",
      });
    }
  });
  contributions.sort((left, right) =>
    left.token.id.localeCompare(right.token.id),
  );

  const tokensById = new Map<string, CapabilityToken<unknown>>();
  const registerToken = (token: CapabilityToken<unknown>): void => {
    const previous = tokensById.get(token.id);
    if (previous !== undefined && previous !== token) {
      throw new HotUpdaterConstructionError("DUPLICATE_CAPABILITY_TOKEN_ID", {
        tokenId: token.id,
      });
    }
    tokensById.set(token.id, token);
  };
  for (const contribution of contributions) registerToken(contribution.token);
  for (const token of [...(options.requiredTokens ?? [])].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    registerToken(token);
  }

  const providerTokens = new Set<CapabilityToken<unknown>>();
  for (const contribution of contributions) {
    if (providerTokens.has(contribution.token)) {
      throw new HotUpdaterConstructionError("DUPLICATE_CAPABILITY_PROVIDER", {
        tokenId: contribution.token.id,
      });
    }
    providerTokens.add(contribution.token);
  }

  const parsedValues = new Map<CapabilityToken<unknown>, Readonly<object>>();
  for (const contribution of contributions) {
    try {
      const advertised = contribution.create(options.runtime);
      rejectThenable(advertised, contribution.token.id);
      const parsed = contribution.token.parse(advertised);
      rejectThenable(parsed, contribution.token.id);
      parsedValues.set(contribution.token, Object.freeze({ value: parsed }));
    } catch (error) {
      if (error instanceof HotUpdaterConstructionError) throw error;
      invalidCapability(contribution.token.id);
    }
  }

  const forPlugin = (pluginId: string): HotUpdaterPluginCapabilities => {
    const get = <TValue>(
      token: CapabilityToken<TValue>,
    ): TValue | undefined => {
      const parsed = parsedValues.get(token);
      return parsed === undefined ? undefined : Reflect.get(parsed, "value");
    };
    return Object.freeze({
      get,
      require<TValue>(token: CapabilityToken<TValue>): TValue {
        const value = get(token);
        if (value === undefined) {
          throw new HotUpdaterConstructionError("MISSING_CAPABILITY", {
            pluginId,
            tokenId: token.id,
          });
        }
        return value;
      },
    });
  };

  const registryView = forPlugin("<registry>");
  return Object.freeze({
    forPlugin,
    get: registryView.get,
    has: (token: CapabilityToken<unknown>) => parsedValues.has(token),
    require: registryView.require,
  });
};
