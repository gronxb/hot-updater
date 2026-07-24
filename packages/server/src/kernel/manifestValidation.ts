import { HotUpdaterConstructionError } from "./errors";
import {
  isFirstPartyFeatureManifest,
  type FirstPartyFeatureManifest,
} from "./manifest";

const invalidContribution = (pluginId: string): never => {
  throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
    pluginId,
  });
};

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const safePluginId = (value: unknown): string => {
  if (!isObject(value)) return "<invalid>";
  try {
    const id = Reflect.get(value, "id");
    return typeof id === "string" && id.length > 0 ? id : "<invalid>";
  } catch {
    return "<invalid>";
  }
};

const isManifestRequirement = (value: unknown): boolean => {
  if (!isObject(value)) return false;
  const missing = Reflect.get(value, "missing");
  const token = Reflect.get(value, "token");
  return (
    (missing === "continue" || missing === "error") &&
    isObject(token) &&
    typeof Reflect.get(token, "id") === "string" &&
    typeof Reflect.get(token, "parse") === "function"
  );
};

export const validateReadableManifest = (
  value: unknown,
): FirstPartyFeatureManifest => {
  const pluginId = safePluginId(value);
  try {
    if (!isFirstPartyFeatureManifest(value)) {
      return invalidContribution(pluginId);
    }
    const manifest = value;
    const requires = Reflect.get(manifest, "requires");
    if (!Array.isArray(requires) || !requires.every(isManifestRequirement)) {
      invalidContribution(pluginId);
    }
    return manifest;
  } catch (error) {
    if (error instanceof HotUpdaterConstructionError) throw error;
    return invalidContribution(pluginId);
  }
};

export const validateManifestIdentity = (
  manifest: FirstPartyFeatureManifest,
): void => {
  const pluginId = safePluginId(manifest);
  try {
    const aliases = Reflect.get(manifest, "aliases");
    if (
      typeof Reflect.get(manifest, "id") !== "string" ||
      Reflect.get(manifest, "id").length === 0 ||
      typeof Reflect.get(manifest, "namespace") !== "string" ||
      Reflect.get(manifest, "namespace").length === 0 ||
      typeof Reflect.get(manifest, "version") !== "string" ||
      Reflect.get(manifest, "version").length === 0 ||
      typeof Reflect.get(manifest, "setup") !== "function" ||
      !isObject(aliases) ||
      Array.isArray(aliases) ||
      !Object.values(aliases).every((alias) => typeof alias === "string")
    ) {
      invalidContribution(pluginId);
    }
  } catch (error) {
    if (error instanceof HotUpdaterConstructionError) throw error;
    invalidContribution(pluginId);
  }
};
