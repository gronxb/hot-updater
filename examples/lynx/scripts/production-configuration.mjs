const localHost = (host) => {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".invalid")
  );
};

export function resolveProductionAppBaseURL(environment = process.env) {
  const raw = environment.HOT_UPDATER_APP_BASE_URL;
  if (raw === undefined || raw === "") return null;
  if (raw !== raw.trim()) {
    throw new Error("HOT_UPDATER_APP_BASE_URL must not contain whitespace");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("HOT_UPDATER_APP_BASE_URL must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    localHost(url.hostname)
  ) {
    throw new Error(
      "HOT_UPDATER_APP_BASE_URL must be a nonlocal HTTPS URL without credentials or a fragment",
    );
  }
  return url.toString();
}
