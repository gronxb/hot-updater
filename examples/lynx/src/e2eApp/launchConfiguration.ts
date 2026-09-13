export type E2eLaunchConfiguration = {
  readonly appBaseURL: string;
  readonly runtimeConfigURL: string;
};

const defaults: E2eLaunchConfiguration = {
  appBaseURL: "http://localhost:3007/hot-updater",
  runtimeConfigURL: "http://localhost:3107/e2e/runtime-config",
};

function hasUnsafeUrlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || character === "\\") return true;
  }
  return false;
}

function httpURL(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const match =
    /^https?:\/\/(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#].*)?$/i.exec(
      value,
    );
  if (
    hasUnsafeUrlCharacter(value) ||
    !match ||
    (match[2] !== undefined && Number(match[2]) > 65535)
  ) {
    throw new Error("Lynx launch endpoint must use HTTP or HTTPS");
  }
  return value;
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

export async function readE2eLaunchConfiguration(
  nativeModulesAvailable: boolean,
  readNativeConfiguration: () => Promise<Readonly<Record<string, string>>>,
): Promise<E2eLaunchConfiguration | null> {
  if (!nativeModulesAvailable) return null;
  return resolveE2eLaunchConfiguration(await readNativeConfiguration());
}
