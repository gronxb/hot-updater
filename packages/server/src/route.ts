export const normalizeBasePath = (basePath?: string) => {
  if (!basePath || basePath === "/") {
    return "/";
  }

  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
};

export const wildcardPattern = (basePath: string) => {
  const normalized = normalizeBasePath(basePath);
  return normalized === "/" ? "/*" : `${normalized}/*`;
};

export const isCanonicalUpdateRoute = (basePath: string, path: string) => {
  const normalized = normalizeBasePath(basePath);
  const appVersionPrefix =
    normalized === "/" ? "/app-version/" : `${normalized}/app-version/`;
  const fingerprintPrefix =
    normalized === "/" ? "/fingerprint/" : `${normalized}/fingerprint/`;

  return (
    path.startsWith(appVersionPrefix) || path.startsWith(fingerprintPrefix)
  );
};
