export async function getBundleZipTargets(
  basePath: string,
  files: string[],
): Promise<{ path: string; name: string }[]> {
  const bundleCandidates: Record<string, string> = {};
  const targets: { path: string; name: string }[] = [];

  const getRelative = (file: string): string =>
    file.startsWith(basePath) ? file.slice(basePath.length) : file;

  for (const file of files) {
    if (file.endsWith(".map")) {
      continue;
    }
    const relative = getRelative(file);

    if (relative.endsWith(".bundle") || relative.endsWith(".bundle.hbc")) {
      let bundleBase = relative;
      if (relative.endsWith(".bundle.hbc")) {
        bundleBase = relative.slice(0, -4);
      }
      if (bundleCandidates[bundleBase]) {
        if (
          !bundleCandidates[bundleBase]?.endsWith(".hbc") &&
          file.endsWith(".hbc")
        ) {
          bundleCandidates[bundleBase] = file;
        }
      } else {
        bundleCandidates[bundleBase] = file;
      }
    } else {
      targets.push({ path: file, name: relative });
    }
  }

  for (const bundleBase in bundleCandidates) {
    if (!bundleCandidates[bundleBase]) {
      continue;
    }
    targets.push({ path: bundleCandidates[bundleBase], name: bundleBase });
  }

  return targets;
}
