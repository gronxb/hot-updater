import type {
  FeatureInvocationMap,
  FeatureMemberInvocationMetadata,
} from "@hot-updater/plugin-core";

const isPlainRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

export const readFeatureInvocation = (
  value: unknown,
  apiValue: Readonly<Record<string, unknown>>,
): FeatureInvocationMap => {
  if (!isPlainRecord(value)) {
    throw new Error("Invalid API contribution.");
  }
  const readMetadata = (
    metadata: unknown,
  ): FeatureMemberInvocationMetadata | undefined => {
    if (!isPlainRecord(metadata)) return undefined;
    const publicArity = metadata.publicArity;
    const contextIndex = metadata.contextIndex;
    return Object.keys(metadata).sort().join(",") ===
      "contextIndex,publicArity" &&
      typeof publicArity === "number" &&
      Number.isSafeInteger(publicArity) &&
      publicArity >= 1 &&
      typeof contextIndex === "number" &&
      Number.isSafeInteger(contextIndex) &&
      contextIndex >= 0 &&
      contextIndex === publicArity - 1
      ? Object.freeze({ contextIndex, publicArity })
      : undefined;
  };
  const callableKeys = Object.keys(apiValue)
    .filter((key) => typeof apiValue[key] === "function")
    .sort();
  const invocationKeys = Object.keys(value).sort();
  if (
    callableKeys.length !== invocationKeys.length ||
    !callableKeys.every((key, index) => {
      if (key !== invocationKeys[index]) return false;
      return readMetadata(value[key]) !== undefined;
    })
  ) {
    throw new Error("Invalid API contribution.");
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([member, metadata]) => {
        const parsed = readMetadata(metadata);
        if (parsed === undefined) {
          throw new Error("Invalid API contribution.");
        }
        return [member, parsed];
      }),
    ),
  ) as FeatureInvocationMap;
};
