export const MAX_BUNDLE_ARCHIVE_ENTRIES = 10_000;
export const MAX_DECLARED_BUNDLE_ARTIFACTS = MAX_BUNDLE_ARCHIVE_ENTRIES - 1;
export const MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES = 1024;

/** Canonical key used to reject paths that collide on supported native filesystems. */
export const getPortableArtifactPathCollisionKey = (name: string): string =>
  name.normalize("NFC").toUpperCase().toLowerCase();

export const getUtf8ByteSize = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

/** Counts files plus generated manifest.json and unique parent directories. */
export const getBundleArchiveEntryCount = (
  names: readonly string[],
): number => {
  const directories = new Set<string>();
  for (const name of names) {
    const key = getPortableArtifactPathCollisionKey(name);
    let separator = key.indexOf("/");
    while (separator !== -1) {
      directories.add(key.slice(0, separator));
      separator = key.indexOf("/", separator + 1);
    }
  }
  return 1 + names.length + directories.size;
};

export type PortableArtifactPathConflict =
  | {
      kind: "duplicate";
      first: string;
      second: string;
    }
  | {
      kind: "ancestor";
      ancestor: string;
      descendant: string;
    }
  | {
      kind: "directory-alias";
      first: string;
      second: string;
    };

export const findPortableArtifactPathConflict = (
  names: readonly string[],
): PortableArtifactPathConflict | null => {
  const entriesByKey = new Map<
    string,
    { kind: "file" | "directory"; name: string }
  >();
  for (const name of names) {
    const key = getPortableArtifactPathCollisionKey(name);
    const existing = entriesByKey.get(key);
    if (existing !== undefined) {
      return { kind: "duplicate", first: existing.name, second: name };
    }
    entriesByKey.set(key, { kind: "file", name });
  }

  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      const key = getPortableArtifactPathCollisionKey(directory);
      const existing = entriesByKey.get(key);
      if (existing?.kind === "file") {
        return {
          kind: "ancestor",
          ancestor: existing.name,
          descendant: name,
        };
      }
      if (existing?.kind === "directory" && existing.name !== directory) {
        return {
          kind: "directory-alias",
          first: existing.name,
          second: directory,
        };
      }
      if (existing === undefined) {
        entriesByKey.set(key, { kind: "directory", name: directory });
      }
    }
  }
  return null;
};
