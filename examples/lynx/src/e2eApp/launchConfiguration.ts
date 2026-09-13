export type E2eLaunchConfiguration = {
  readonly appBaseURL: string;
  readonly runtimeConfigURL: string;
};

const defaults: E2eLaunchConfiguration = {
  appBaseURL: "http://localhost:3007/hot-updater",
  runtimeConfigURL: "http://localhost:3107/e2e/runtime-config",
};

function httpURL(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Lynx launch endpoint must use HTTP or HTTPS");
  }
  return url.toString();
}

export function resolveE2eLaunchConfiguration(
  value: Readonly<Record<string, string>>,
): E2eLaunchConfiguration {
  return {
    appBaseURL: httpURL(value.appBaseURL, defaults.appBaseURL),
    runtimeConfigURL: httpURL(
      value.runtimeConfigURL,
      defaults.runtimeConfigURL,
    ),
  };
}
