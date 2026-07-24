import type {
  CapabilityToken,
  HotUpdaterInfrastructureRuntime,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";

import { HotUpdaterConstructionError } from "./errors";

export interface PluginCapabilityRegistry {
  get<TValue>(token: CapabilityToken<TValue>): TValue | undefined;
  require<TValue>(token: CapabilityToken<TValue>): TValue;
}

export interface CapabilityRegistry extends PluginCapabilityRegistry {
  forPlugin(pluginId: string): PluginCapabilityRegistry;
  has(token: CapabilityToken<unknown>): boolean;
}

export type CreateCapabilityRegistryOptions = {
  readonly carriers: readonly object[];
  readonly requiredTokens?: readonly CapabilityToken<unknown>[];
  readonly runtime: HotUpdaterInfrastructureRuntime;
};

const invalidCapability = (tokenId: string): never => {
  throw new HotUpdaterConstructionError("INVALID_CAPABILITY", { tokenId });
};

const parseCapability = <TValue>(
  token: CapabilityToken<TValue>,
  value: unknown,
): TValue => {
  try {
    return token.parse(value);
  } catch {
    return invalidCapability(token.id);
  }
};

const isThenable = (value: unknown): boolean => {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
};

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
  for (const contribution of contributions) {
    registerToken(contribution.token);
  }
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
      if (isThenable(advertised)) {
        if (advertised instanceof Promise) {
          void advertised.catch(() => undefined);
        }
        invalidCapability(contribution.token.id);
      }
      const parsed = parseCapability(contribution.token, advertised);
      parsedValues.set(contribution.token, Object.freeze({ value: parsed }));
    } catch (error) {
      if (error instanceof HotUpdaterConstructionError) throw error;
      invalidCapability(contribution.token.id);
    }
  }

  const forPlugin = (pluginId: string): PluginCapabilityRegistry => {
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
    has(token: CapabilityToken<unknown>) {
      return parsedValues.has(token);
    },
    require: registryView.require,
  });
};
