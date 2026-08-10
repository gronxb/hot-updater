import type { UniversalComponentArtifact } from "@hot-updater/plugin-core";

type FirestoreIndexFile = Readonly<Record<string, unknown>> & {
  readonly fieldOverrides: readonly unknown[];
  readonly indexes: readonly unknown[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJson(value));

const compareCanonicalJson = (left: unknown, right: unknown): number => {
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
};

const parseIndexFile = (
  contents: string,
  source: string,
): FirestoreIndexFile => {
  const parsed: unknown = JSON.parse(contents);
  if (
    !isRecord(parsed) ||
    (parsed.indexes !== undefined && !Array.isArray(parsed.indexes)) ||
    (parsed.fieldOverrides !== undefined &&
      !Array.isArray(parsed.fieldOverrides))
  ) {
    throw new TypeError(`Invalid Firestore index JSON: ${source}`);
  }
  return {
    ...parsed,
    fieldOverrides: parsed.fieldOverrides ?? [],
    indexes: parsed.indexes ?? [],
  };
};

const mergeJsonEntries = (entries: readonly unknown[]): readonly unknown[] =>
  [
    ...new Map(entries.map((entry) => [canonicalJson(entry), entry])).values(),
  ].toSorted(compareCanonicalJson);

const fieldOverrideKey = (entry: unknown): string => {
  if (
    !isRecord(entry) ||
    typeof entry.collectionGroup !== "string" ||
    typeof entry.fieldPath !== "string"
  ) {
    throw new TypeError("Invalid Firestore field override");
  }
  return `${entry.collectionGroup}\0${entry.fieldPath}`;
};

const mergeFieldOverrides = (entries: readonly unknown[]): readonly unknown[] =>
  [
    ...new Map(
      entries.map((entry) => [fieldOverrideKey(entry), entry]),
    ).values(),
  ].toSorted(compareCanonicalJson);

export const mergeFirebaseComponentIndexArtifacts = (
  existingContents: string,
  componentArtifacts: readonly UniversalComponentArtifact[],
): string => {
  const existing = parseIndexFile(existingContents, "existing aggregate");
  const fragments = componentArtifacts.map((artifact) =>
    parseIndexFile(artifact.contents, artifact.path),
  );
  const merged = canonicalizeJson({
    ...existing,
    fieldOverrides: mergeFieldOverrides([
      ...existing.fieldOverrides,
      ...fragments.flatMap((fragment) => fragment.fieldOverrides),
    ]),
    indexes: mergeJsonEntries([
      ...existing.indexes,
      ...fragments.flatMap((fragment) => fragment.indexes),
    ]),
  });
  return `${JSON.stringify(merged, null, 2)}\n`;
};
