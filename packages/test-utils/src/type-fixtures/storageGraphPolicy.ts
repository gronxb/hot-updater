export type StorageGraphEdge = Readonly<{
  importer: string;
  resolvedTarget: string | null;
  specifier: string;
}>;

export type StorageGraphManifest = Readonly<{
  edges: readonly StorageGraphEdge[];
  entry: string;
}>;

export type StorageGraphPolicy = Readonly<{
  allowedExternalPrefixes: readonly string[];
  deniedExternalPrefixes: readonly string[];
  target: string;
}>;

export class StorageGraphPolicyError extends Error {
  readonly violations: readonly StorageGraphEdge[];

  constructor(target: string, violations: readonly StorageGraphEdge[]) {
    super(
      [
        `Forbidden import graph for target ${target}:`,
        ...violations.map(
          ({ importer, resolvedTarget, specifier }) =>
            `${importer} -> ${specifier} -> ${resolvedTarget ?? "unresolved"}`,
        ),
      ].join("\n"),
    );
    this.name = "StorageGraphPolicyError";
    this.violations = violations;
  }
}

const isExternal = (specifier: string): boolean =>
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !specifier.startsWith("file:");

const matchesPrefix = (
  specifier: string,
  prefixes: readonly string[],
): boolean =>
  prefixes.some(
    (prefix) =>
      specifier === prefix ||
      specifier.startsWith(`${prefix}/`) ||
      ((prefix.endsWith(":") || prefix.endsWith("/")) &&
        specifier.startsWith(prefix)),
  );

export const assertStorageGraphPolicy = (
  manifest: StorageGraphManifest,
  policy: StorageGraphPolicy,
): void => {
  const violations = manifest.edges.filter(({ specifier }) => {
    if (!isExternal(specifier)) {
      return false;
    }
    if (matchesPrefix(specifier, policy.allowedExternalPrefixes)) {
      return false;
    }
    return true;
  });
  if (violations.length > 0) {
    throw new StorageGraphPolicyError(policy.target, violations);
  }
};
