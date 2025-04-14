import path from "path";

export async function getBundleZipTargets(
  basePath: string,
  files: string[],
): Promise<{ path: string; name: string }[]> {
  const bundleCandidates: Record<string, string> = {};
  const targets: { path: string; name: string }[] = [];

  const normalizeToPosix = (filePath: string) =>
    filePath.split(path.sep).join("/");

  const normalizedBase = normalizeToPosix(path.normalize(basePath));

  const getRelative = (file: string): string => {
    const normalizedFile = normalizeToPosix(path.normalize(file));

    if (normalizedFile.startsWith(`${normalizedBase}/`)) {
      return normalizedFile.slice(normalizedBase.length + 1);
    }
    return normalizedFile;
  };

  for (const file of files) {
    const normalizedFile = normalizeToPosix(path.normalize(file));

    if (normalizedFile.endsWith(".map")) {
      continue;
    }

    const relative = getRelative(normalizedFile);

    if (relative.endsWith(".bundle") || relative.endsWith(".bundle.hbc")) {
      let bundleBase = relative;
      if (relative.endsWith(".bundle.hbc")) {
        bundleBase = relative.slice(0, -4);
      }
      if (bundleCandidates[bundleBase]) {
        if (
          !bundleCandidates[bundleBase]?.endsWith(".hbc") &&
          normalizedFile.endsWith(".hbc")
        ) {
          bundleCandidates[bundleBase] = normalizedFile;
        }
      } else {
        bundleCandidates[bundleBase] = normalizedFile;
      }
    } else {
      targets.push({
        path: file,
        name: relative.replace(/\\/g, "/"),
      });
    }
  }

  for (const bundleBase in bundleCandidates) {
    if (!bundleCandidates[bundleBase]) continue;
    targets.push({
      path: bundleCandidates[bundleBase],
      name: bundleBase.replace(/\\/g, "/"),
    });
  }

  return targets;
}
